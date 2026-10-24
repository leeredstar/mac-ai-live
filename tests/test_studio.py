"""Focused regressions for queue safety, recovery, media, and loopback HTTP."""
import json
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer

from studio.__main__ import Handler, Studio


def until(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.02)
    raise AssertionError("condition did not become true")


class StudioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.studio = Studio(Path(self.temp.name))

    def tearDown(self):
        self.studio.closed = True
        self.studio.cancel.set()
        with self.studio.changed:
            self.studio.notify()
        self.studio.thread.join(timeout=3)
        self.studio.db.close()
        self.temp.cleanup()

    def test_pending_is_not_performed_until_approved(self):
        with patch.object(self.studio, "speech", return_value=("/audio/test.wav", .01)) as speech:
            job = self.studio.submit({"user": "测试", "text": "挥挥手"})
            self.studio.control("start")
            self.assertEqual(job["status"], "pending")
            speech.assert_not_called()
            self.studio.control("approve", job["id"])
            until(lambda: job["status"] == "done")
            self.assertEqual(speech.call_count, 1)
            self.assertEqual(self.studio.snapshot()["state"]["phase"], "idle")

    def test_pause_interrupts_action_and_keeps_remaining_queue(self):
        with patch.object(self.studio, "speech", return_value=("/audio/test.wav", .1)):
            job = self.studio.submit({"text": "吃一口"})
            self.studio.control("approve", job["id"])
            self.studio.control("start")
            until(lambda: self.studio.snapshot()["state"]["phase"] == "action")
            until(lambda: time.time() - job["created"] > .31)
            next_job = self.studio.submit({"text": "你好"})
            self.studio.control("pause")
            until(lambda: job["status"] == "cancelled")
            snapshot = self.studio.snapshot()
            self.assertFalse(snapshot["running"])
            self.assertEqual(snapshot["state"]["phase"], "idle")
            self.assertEqual(snapshot["queue"][0]["id"], next_job["id"])

    def test_duplicate_is_rejected(self):
        self.studio.submit({"user": "测试", "text": "你好"})
        with self.assertRaisesRegex(ValueError, "队列"):
            self.studio.submit({"user": "测试", "text": "你好"})

    def test_invalid_settings_do_not_partially_save(self):
        with self.assertRaises(ValueError):
            self.studio.settings({"name": "不该保存", "rate": 999})
        self.assertEqual(self.studio.config["name"], "小满")

    def test_restart_preserves_waiting_jobs_and_cancels_active_work(self):
        pending = self.studio.submit({"text": "待处理的弹幕"})
        active = {**pending, "id": "active-copy", "text": "退出时正在表演", "status": "active",
                  "created": pending["created"] + .1}
        self.studio.history.appendleft(active)
        self.studio.save_job(active)
        self.studio.settings({"name": "恢复测试"})
        self.studio.closed = True
        with self.studio.changed:
            self.studio.notify()
        self.studio.thread.join(timeout=2)
        self.studio.db.close()
        self.studio = Studio(Path(self.temp.name))
        snapshot = self.studio.snapshot()
        self.assertEqual(snapshot["config"]["name"], "恢复测试")
        self.assertEqual(snapshot["history"][0]["id"], "active-copy")
        self.assertEqual(snapshot["history"][0]["status"], "cancelled")
        self.assertEqual(snapshot["queue"][0]["id"], pending["id"])
        self.assertEqual(snapshot["queue"][0]["status"], "pending")
        self.assertFalse(snapshot["running"])


class HTTPTests(unittest.TestCase):
    def setUp(self):
        StudioTests.setUp(self)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.studio = self.studio
        self.http_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.http_thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.http_thread.join(timeout=2)
        StudioTests.tearDown(self)

    def request(self, path, data=None, headers=None):
        request = Request(self.base + path, data=data, headers=headers or {})
        try:
            with urlopen(request, timeout=4) as response:
                return response.status, response.read(), response.headers
        except HTTPError as error:
            return error.code, error.read(), error.headers

    def test_wrong_origin_and_host_rejected(self):
        code, _, _ = self.request("/api/control", b'{"command":"start"}',
                                  {"Content-Type": "application/json", "Origin": "https://example.org"})
        self.assertEqual(code, 403)
        code, _, _ = self.request("/api/control", b'{"command":"start"}',
                                  {"Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"})
        self.assertEqual(code, 403)
        code, _, _ = self.request("/api/state", headers={"Host": "example.org"})
        self.assertEqual(code, 403)
        code, _, _ = self.request("/", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(code, 200)
        self.assertFalse(self.studio.running)

    def test_paths_and_range(self):
        (self.studio.data / "audio" / "test.wav").write_bytes(b"0123456789")
        code, body, headers = self.request("/audio/test.wav", headers={"Range": "bytes=2-5"})
        self.assertEqual((code, body), (206, b"2345"))
        self.assertEqual(headers["Content-Range"], "bytes 2-5/10")
        code, _, _ = self.request("/audio/../studio.sqlite3")
        self.assertEqual(code, 404)

    def test_generated_character_assets_and_still_action_fallback(self):
        code, body, headers = self.request("/static/character-xiaoman-v2.png")
        self.assertEqual(code, 200)
        self.assertTrue(body)
        self.assertEqual(headers.get_content_type(), "image/png")
        code, body, headers = self.request("/static/character-xiaoman-v2-thumb.jpg")
        self.assertEqual(code, 200)
        self.assertTrue(body)
        self.assertEqual(headers.get_content_type(), "image/jpeg")
        code, body, _ = self.request("/stage")
        self.assertEqual(code, 200)
        self.assertIn(b'/static/character-xiaoman-v2.png', body)
        self.assertNotIn(b'id="action-pose"', body)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg not installed")
    def test_import_validate_and_unbind_media(self):
        fixture = Path(self.temp.name) / "fixture.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=green:s=160x100:d=0.4",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(fixture)], check=True)
        code, body, _ = self.request("/api/media/eat", fixture.read_bytes(),
                                     {"Content-Type": "application/octet-stream", "X-Filename": "fixture.mp4"})
        self.assertEqual(code, 200, body)
        media = json.loads(body)
        self.assertAlmostEqual(media["duration"], .4, places=1)
        code, body, _ = self.request("/api/media/remove", b'{"action":"eat"}',
                                     {"Content-Type": "application/json"})
        self.assertEqual(code, 200, body)
        self.assertNotIn("eat", self.studio.snapshot()["media"])
        self.assertTrue((self.studio.data / "media" / Path(media["url"]).name).exists())
        code, _, _ = self.request("/api/media/eat", b"this is not a video",
                                  {"Content-Type": "application/octet-stream", "X-Filename": "fake.mp4"})
        self.assertEqual(code, 400)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg not installed")
    def test_import_one_video_and_cut_action_clip_locally(self):
        fixture = Path(self.temp.name) / "long-take.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2.4",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(fixture)], check=True)
        code, body, _ = self.request("/api/source", fixture.read_bytes(),
                                     {"Content-Type": "application/octet-stream", "X-Filename": "long-take.mp4"})
        self.assertEqual(code, 200, body)
        source = json.loads(body)
        code, _, headers = self.request(source["url"], headers={"Range": "bytes=0-15"})
        self.assertEqual(code, 206)
        self.assertEqual(headers["Content-Length"], "16")
        payload = json.dumps({"source_id": source["id"], "action": "wave", "start": 0.4, "end": 1.3}).encode()
        code, body, _ = self.request("/api/media/clip", payload, {"Content-Type": "application/json"})
        self.assertEqual(code, 200, body)
        clip = json.loads(body)
        self.assertTrue(clip["url"].endswith(".mp4"))
        self.assertAlmostEqual(clip["duration"], .9, delta=.15)
        self.assertEqual(self.studio.snapshot()["media"]["wave"], clip)
        code, body, _ = self.request("/api/source/remove", b"{}", {"Content-Type": "application/json"})
        self.assertEqual(code, 200, body)
        code, _, _ = self.request(source["url"])
        self.assertEqual(code, 404)
        self.assertIn("wave", self.studio.snapshot()["media"])


if __name__ == "__main__":
    unittest.main()
