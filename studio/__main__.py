"""No third-party packages. Run: python3 -m studio --open"""
import argparse
import collections
import json
import math
import mimetypes
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import wave
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import unquote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("MAC_AI_LIVE_DATA", ROOT.parent / "data")).resolve()
ACTIONS = {"idle": "待机", "talk": "说话", "eat": "吃一口", "drink": "喝水",
           "wave": "挥手", "laugh": "笑一笑", "nod": "点头"}
ACTION_PREVIEW_SECONDS = {"eat": 3.0, "drink": 3.0, "wave": 2.4, "laugh": 2.0, "nod": 2.0}
DEFAULTS = {"name": "小满", "voice": "Tingting", "rate": 185, "engine": "rules",
            "model": "qwen2.5:1.5b", "persona": "你是小满，一个坦诚、温暖、有点幽默的 AI 主播。用中文简短回答，不编造现实经历。",
            "volume": 0.8, "subtitles": True, "auto_approve": False}
MAX_UPLOAD = 150 * 1024 * 1024


def clean(value, limit=300):
    return re.sub(r"[\x00-\x1f\x7f]", " ", str(value)).strip()[:limit]


def intent(text):
    for action, words in (("eat", ("吃", "咬一口", "蛋糕", "零食")),
                          ("drink", ("喝水", "喝一口", "喝茶")),
                          ("wave", ("挥手", "招手", "打招呼")),
                          ("laugh", ("笑一个", "笑一笑", "笑一下")),
                          ("nod", ("点头",))):
        if any(word in text for word in words):
            return action
    return "talk"


def rule_reply(name, user, text, action):
    prefix = f"{user}，" if user else ""
    replies = {"eat": "吃了一口啦。慢慢吃，咱们边休息边聊。",
               "drink": "喝好水啦。你也记得喝点水，别一直盯着屏幕。",
               "wave": "看到你啦，给你挥挥手！今天过得怎么样？",
               "laugh": "哈哈，希望这个笑容能让你的心情好一点。",
               "nod": "好呀，认真点头。你的话我听到了。"}
    if action in replies:
        return prefix + replies[action]
    if any(w in text for w in ("真人", "AI", "机器人", "人工智能", "假的")):
        return f"{prefix}我是{name}，一个 AI 虚拟主播。现在是本地素材驱动演示，不是真人。"
    if any(w in text for w in ("名字", "叫什么", "你是谁")):
        return f"{prefix}我叫{name}。很高兴在这里认识你。"
    if any(w in text for w in ("累", "难过", "烦", "压力")):
        return prefix + "先歇一会儿吧。你愿意说说今天发生了什么吗？"
    if any(w in text for w in ("你好", "晚上好", "早上好", "来了")):
        return prefix + "你好呀，欢迎来坐一会儿。可以让我挥手、喝水，或者吃一口。"
    if any(w in text for w in ("唱", "跳舞", "换衣")):
        return prefix + "这项表演还没有准备好素材，先让我挥个手吧。"
    return prefix + "这条问题我收到了。目前是规则演示模式，自由问答需要在设置里连接本地 Ollama 模型。"


class Studio:
    def __init__(self, data):
        self.data = data
        for directory in (data, data / "media", data / "audio", data / "source"):
            directory.mkdir(parents=True, exist_ok=True)
        self.source_dir = data / "source"
        for old_source in self.source_dir.iterdir():
            if old_source.is_file():
                old_source.unlink(missing_ok=True)
        self.source_info = None
        self.source_path = None
        self.clip_lock = threading.Lock()
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.cancel = threading.Event()
        self.closed = False
        self.running = False
        self.revision = 0
        self.config = dict(DEFAULTS)
        self.media = {}
        self.jobs = collections.deque()
        self.current = None
        self.state = {"phase": "idle", "action": "idle", "text": "", "audio": None,
                      "start": time.time(), "duration": 0, "job_id": None}
        self.db = sqlite3.connect(data / "studio.sqlite3", check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, value TEXT)")
        stored = dict(self.db.execute("SELECT key,value FROM settings"))
        if "config" in stored:
            self.config.update(json.loads(stored["config"]))
        if "media" in stored:
            self.media.update(json.loads(stored["media"]))
        self.history = collections.deque((json.loads(row[0]) for row in self.db.execute(
            "SELECT value FROM history ORDER BY rowid DESC LIMIT 60")), maxlen=60)
        recoverable = []
        for row in self.history:
            if row["status"] in ("queued", "pending"):
                recoverable.append(row)
            elif row["status"] == "active":
                row["status"] = "cancelled"
                row["error"] = "上次退出时正在表演；请重新提交"
                self.save_job(row)
        self.jobs.extend(sorted(recoverable, key=lambda row: row["created"]))
        self.thread = threading.Thread(target=self.work, daemon=True)
        self.thread.start()

    def save_job(self, job):
        self.db.execute("INSERT OR REPLACE INTO history VALUES (?,?)", (job["id"], json.dumps(job, ensure_ascii=False)))
        self.db.commit()

    def persist(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))
        self.db.commit()

    def notify(self):
        self.revision += 1
        self.changed.notify_all()

    def snapshot(self):
        with self.lock:
            return {"revision": self.revision, "running": self.running,
                    "config": dict(self.config), "media": dict(self.media),
                    "state": dict(self.state), "queue": [dict(j) for j in self.jobs],
                    "history": [dict(j) for j in self.history], "server_time": time.time(),
                    "capabilities": {"tts": bool(shutil.which("say") and shutil.which("afconvert")),
                                     "ffprobe": bool(shutil.which("ffprobe")),
                                     "douyin": False, "gpu": False, "clipper": True, "version": "0.9.0"}}

    def submit(self, payload):
        user = clean(payload.get("user", "观众"), 24)
        text = clean(payload.get("text", ""), 300)
        if not text:
            raise ValueError("请先输入弹幕")
        action = payload.get("action") or intent(text)
        if action not in ACTIONS or action == "idle":
            raise ValueError("不支持的动作")
        with self.lock:
            if len(self.jobs) >= 30:
                raise ValueError("队列已满（30 条），请先处理或清空")
            if any(j["user"] == user and j["text"] == text for j in self.jobs):
                raise ValueError("这条弹幕已在队列里")
            now = time.time()
            if self.history and now - self.history[0]["created"] < 0.3:
                raise ValueError("提交太快，请稍等片刻")
            job = {"id": uuid.uuid4().hex, "user": user, "text": text, "action": action,
                   "status": "queued" if self.config["auto_approve"] else "pending",
                   "created": now, "reply": "", "error": ""}
            self.jobs.append(job)
            self.history.appendleft(job)
            self.save_job(job)
            self.notify()
            return job

    def settings(self, values):
        with self.lock:
            config = dict(self.config)
            for key, value in values.items():
                if key not in DEFAULTS:
                    raise ValueError("未知设置")
                if key in ("subtitles", "auto_approve"):
                    if not isinstance(value, bool):
                        raise ValueError("开关设置必须为布尔值")
                elif key == "voice":
                    if value not in ("Tingting", "Meijia"):
                        raise ValueError("请选择支持的本地中文声音")
                elif key == "engine":
                    if value not in ("rules", "ollama"):
                        raise ValueError("不支持的回答引擎")
                elif key in ("rate", "volume"):
                    value = float(value)
                    if not math.isfinite(value) or not ((100 <= value <= 280) if key == "rate" else (0 <= value <= 1)):
                        raise ValueError("语速或音量超出范围")
                    if key == "rate":
                        value = int(value)
                else:
                    value = clean(value, 1200 if key == "persona" else 80)
                    if not value:
                        raise ValueError("设置不能为空")
                config[key] = value
            self.config = config
            self.persist("config", config)
            self.notify()

    def control(self, command, job_id=None):
        with self.lock:
            if command == "start":
                self.running = True
            elif command in ("pause", "clear", "interrupt"):
                if command == "pause":
                    self.running = False
                self.cancel.set()
                self.set_state("idle", "idle", "", None, 0)
                if command == "clear":
                    for job in self.jobs:
                        job["status"] = "cancelled"
                        self.save_job(job)
                    self.jobs.clear()
            elif command in ("approve", "reject"):
                job = next((j for j in self.jobs if j["id"] == job_id), None)
                if not job:
                    raise ValueError("这条弹幕已处理")
                if command == "approve":
                    job["status"] = "queued"
                else:
                    self.jobs.remove(job)
                    job["status"] = "rejected"
                self.save_job(job)
            else:
                raise ValueError("未知操作")
            self.notify()

    def set_state(self, phase, action, text, audio, duration):
        self.state = {"phase": phase, "action": action, "text": text, "audio": audio,
                      "duration": duration, "start": time.time(),
                      "job_id": self.current["id"] if self.current else None}
        self.notify()

    def reply(self, job, config):
        if config["engine"] == "rules":
            return rule_reply(config["name"], job["user"], job["text"], job["action"])
        # Loopback-only endpoint. CPU mode is explicit; never downloads a model automatically.
        body = {"model": config["model"], "stream": False, "keep_alive": "5m",
                "options": {"num_gpu": 0, "num_predict": 100, "num_ctx": 2048},
                "messages": [{"role": "system", "content": config["persona"] +
                              " 只回答两句，不使用 Markdown。你是虚拟主播，不假装真人。"},
                             {"role": "user", "content": f"观众{job['user']}说：{job['text']}。本次展示动作：{ACTIONS[job['action']]}。"}]}
        req = Request("http://127.0.0.1:11434/api/chat", data=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=90) as response:
                result = json.loads(response.read(1024 * 1024))
            answer = re.sub(r"<think>.*?</think>", "", result["message"]["content"], flags=re.S)
            answer = clean(answer, 220)
            if not answer:
                raise ValueError("本地模型返回了空回答")
            return answer
        except (URLError, KeyError, json.JSONDecodeError, TimeoutError) as exc:
            raise ValueError("本地模型不可用：请启动 Ollama 并安装设置中的模型，或切回规则演示") from exc

    def run_process(self, args, timeout):
        process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                if self.cancel.wait(0.05):
                    raise InterruptedError()
                if time.monotonic() > deadline:
                    raise ValueError("本地语音合成超时")
            if process.returncode:
                raise ValueError("本地语音合成失败，请检查 macOS 中文声音是否已安装")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if process.stderr:
                process.stderr.close()

    def speech(self, text, config, job_id):
        if not (shutil.which("say") and shutil.which("afconvert")):
            raise ValueError("未找到 macOS say / afconvert，语音仅支持 Mac")
        source = self.data / "audio" / (job_id + ".aiff")
        output = source.with_suffix(".wav")
        try:
            # Arguments are passed directly; viewer text is never executed by a shell.
            self.run_process(["say", "-v", config["voice"], "-r", str(config["rate"]),
                              "-o", str(source), "--", text], 30)
            self.run_process(["afconvert", "-f", "WAVE", "-d", "LEI16", str(source), str(output)], 15)
            with wave.open(str(output)) as audio:
                duration = audio.getnframes() / audio.getframerate()
            return "/audio/" + output.name, duration
        finally:
            source.unlink(missing_ok=True)

    def work(self):
        while not self.closed:
            with self.changed:
                job = next((j for j in self.jobs if j["status"] == "queued"), None)
                if not self.running or not job:
                    self.changed.wait(timeout=1)
                    continue
                self.jobs.remove(job)
                self.current = job
                self.cancel.clear()
                config = dict(self.config)
                job["status"] = "active"
                self.save_job(job)
                self.set_state("thinking", "idle", "", None, 0)
            try:
                answer = self.reply(job, config)
                if self.cancel.is_set():
                    raise InterruptedError()
                with self.lock:
                    job["reply"] = answer
                if job["action"] != "talk":
                    with self.lock:
                        if self.cancel.is_set():
                            raise InterruptedError()
                        action_duration = self.media.get(
                            job["action"], {}).get("duration", ACTION_PREVIEW_SECONDS[job["action"]])
                        self.set_state("action", job["action"], "", None, action_duration)
                    if self.cancel.wait(action_duration):
                        raise InterruptedError()
                if self.cancel.is_set():
                    raise InterruptedError()
                audio, duration = self.speech(answer, config, job["id"])
                with self.lock:
                    if self.cancel.is_set():
                        raise InterruptedError()
                    self.set_state("speaking", "talk", answer, audio, duration + 0.5)
                if self.cancel.wait(duration + 0.5):
                    raise InterruptedError()
                with self.lock:
                    job["status"] = "done"
            except InterruptedError:
                with self.lock:
                    job["status"] = "cancelled"
            except Exception as exc:
                with self.lock:
                    job["status"] = "failed"
                    job["error"] = clean(str(exc), 180)
            finally:
                with self.lock:
                    self.save_job(job)
                    self.current = None
                    self.set_state("idle", "idle", "", None, 0)
                # Keep the latest 60 audio files. User media is never auto-deleted.
                files = sorted((self.data / "audio").glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
                for old in files[60:]:
                    old.unlink(missing_ok=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def studio(self):
        return self.server.studio

    def log_message(self, fmt, *args):
        # Avoid writing viewer messages or query strings into terminal logs.
        pass

    def allowed(self, read_only=False):
        expected = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if self.headers.get("Host") not in expected:
            self.send_json({"error": "只允许本机访问"}, 403)
            return False
        if not read_only:
            origin = self.headers.get("Origin")
            if origin and origin not in {"http://" + host for host in expected}:
                self.send_json({"error": "不允许跨站请求"}, 403)
                return False
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.send_json({"error": "不允许跨站请求"}, 403)
                return False
        return True

    def headers_for(self, status, content_type, length=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self'")
        self.end_headers()

    def send_json(self, value, status=200):
        raw = json.dumps(value, ensure_ascii=False).encode()
        self.headers_for(status, "application/json; charset=utf-8", len(raw))
        self.wfile.write(raw)

    def do_GET(self):
        if not self.allowed(read_only=True):
            return
        path = unquote(urlparse(self.path).path)
        if path == "/api/state":
            return self.send_json(self.studio.snapshot())
        if path == "/api/events":
            self.headers_for(200, "text/event-stream; charset=utf-8")
            last = -1
            try:
                while not self.studio.closed:
                    with self.studio.changed:
                        if self.studio.revision == last:
                            self.studio.changed.wait(timeout=12)
                        state = self.studio.snapshot()
                    last = state["revision"]
                    self.wfile.write(("data: " + json.dumps(state, ensure_ascii=False) + "\n\n").encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            self.close_connection = True
            return
        if path in ("/", "/stage"):
            return self.send_file(ROOT / "static" / ("index.html" if path == "/" else "stage.html"))
        if path.startswith("/static/"):
            base, relative = ROOT / "static", path[8:]
        elif path.startswith("/source/"):
            if not self.studio.source_info or path != self.studio.source_info["url"]:
                return self.send_json({"error": "素材源不存在"}, 404)
            return self.send_file(self.studio.source_path)
        elif path.startswith("/media/"):
            base, relative = self.studio.data / "media", path[7:]
        elif path.startswith("/audio/"):
            base, relative = self.studio.data / "audio", path[7:]
        else:
            return self.send_json({"error": "未找到"}, 404)
        file = (base / relative).resolve()
        base_resolved = base.resolve()
        if file == base_resolved or base_resolved not in file.parents:
            return self.send_json({"error": "未找到"}, 404)
        return self.send_file(file)

    def send_file(self, path):
        if not path.is_file():
            return self.send_json({"error": "文件不存在"}, 404)
        size = path.stat().st_size
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if content_type.startswith("text/"):
            content_type += "; charset=utf-8"
        start, end = 0, size - 1
        range_header = self.headers.get("Range")
        status = 200
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            if not match or not any(match.groups()):
                return self.send_json({"error": "无效的媒体范围"}, 416)
            first, last = match.groups()
            if first:
                start = int(first)
                end = min(int(last), end) if last else end
            else:
                start = max(0, size - int(last))
            if start > end or start >= size:
                return self.send_json({"error": "媒体范围越界"}, 416)
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("X-Content-Type-Options", "nosniff")
        if path.suffix == ".html":
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'self'")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            with path.open("rb") as source:
                source.seek(start)
                remaining = end - start + 1
                while remaining:
                    block = source.read(min(65536, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if not self.allowed():
            self.close_connection = True
            return
        try:
            path = urlparse(self.path).path
            length = int(self.headers.get("Content-Length", "0"))
            if path == "/api/source":
                return self.upload_source(length)
            if path.startswith("/api/media/") and path != "/api/media/remove":
                if path == "/api/media/clip":
                    if not 0 < length <= 32768 or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                        self.close_connection = True
                        return self.send_json({"error": "请求无效"}, 415)
                    payload = json.loads(self.rfile.read(length))
                    return self.make_clip(payload)
                return self.upload(path.rsplit("/", 1)[-1], length)
            if not 0 < length <= 32768:
                self.close_connection = True
                return self.send_json({"error": "请求过大或为空"}, 413)
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                self.close_connection = True
                return self.send_json({"error": "仅接收 JSON"}, 415)
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("请求必须为对象")
            if path == "/api/comments":
                result = self.studio.submit(payload)
            elif path == "/api/control":
                self.studio.control(payload.get("command"), payload.get("id"))
                result = {"ok": True}
            elif path == "/api/settings":
                self.studio.settings(payload)
                result = {"ok": True}
            elif path == "/api/media/remove":
                action = payload.get("action")
                with self.studio.lock:
                    if action in self.studio.media:
                        del self.studio.media[action]
                        self.studio.persist("media", self.studio.media)
                        self.studio.notify()
                result = {"ok": True}
            elif path == "/api/source/remove":
                with self.studio.clip_lock:
                    self.remove_source()
                result = {"ok": True}
            else:
                return self.send_json({"error": "未找到接口"}, 404)
            return self.send_json(result)
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self.close_connection = True
            return self.send_json({"error": clean(str(exc), 200)}, 400)
        except (OSError, sqlite3.Error):
            self.close_connection = True
            return self.send_json({"error": "本地文件或数据库操作失败，请检查磁盘空间"}, 500)

    def remove_source(self):
        if self.studio.source_path:
            self.studio.source_path.unlink(missing_ok=True)
        self.studio.source_path = None
        self.studio.source_info = None

    def upload_source(self, length):
        if not 0 < length <= MAX_UPLOAD:
            self.close_connection = True
            raise ValueError("素材无效或超过 150 MB")
        suffix = Path(unquote(self.headers.get("X-Filename", ""))).suffix.lower()
        if suffix not in (".mp4", ".webm"):
            self.close_connection = True
            raise ValueError("请选择 MP4 或 WebM 视频")
        if not shutil.which("ffprobe"):
            self.close_connection = True
            raise ValueError("验证视频需要 FFmpeg，请先运行 brew install ffmpeg")
        file = self.studio.source_dir / (uuid.uuid4().hex + suffix)
        try:
            with file.open("wb") as dest:
                remaining = length
                while remaining:
                    block = self.rfile.read(min(65536, remaining))
                    if not block:
                        raise ValueError("上传中断，请重新选择视频")
                    remaining -= len(block)
                    dest.write(block)
            with file.open("rb") as source:
                header = source.read(32)
            if not ((suffix == ".mp4" and b"ftyp" in header) or
                    (suffix == ".webm" and header.startswith(b"\x1aE\xdf\xa3"))):
                raise ValueError("文件不是有效的 MP4/WebM")
            result = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", str(file)],
                capture_output=True, timeout=15)
            info = json.loads(result.stdout)
            video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
            duration = float(info.get("format", {}).get("duration", 0))
            if (result.returncode or not video or not math.isfinite(duration) or not 0.1 <= duration <= 1800 or
                    int(video.get("width") or 0) <= 0 or int(video.get("height") or 0) <= 0):
                raise ValueError("视频必须包含画面，时长不超过 30 分钟")
            if suffix == ".mp4" and video.get("codec_name") != "h264":
                raise ValueError("MP4 请使用 H.264 编码")
            if suffix == ".webm" and video.get("codec_name") not in ("vp8", "vp9", "av1"):
                raise ValueError("WebM 请使用 VP8、VP9 或 AV1 编码")
            source_id = uuid.uuid4().hex
            with self.studio.clip_lock:
                self.remove_source()
                self.studio.source_path = file
                self.studio.source_info = {"id": source_id, "url": "/source/" + file.name,
                    "name": clean(unquote(self.headers.get("X-Filename", "素材")), 100),
                    "duration": duration, "width": video.get("width"), "height": video.get("height")}
            self.send_json({k: v for k, v in self.studio.source_info.items()})
        except (ValueError, KeyError, subprocess.TimeoutExpired, json.JSONDecodeError):
            file.unlink(missing_ok=True)
            raise ValueError("视频校验失败：请使用不超过 30 分钟的 H.264 MP4 或标准 WebM")

    def make_clip(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("请求必须为对象")
        action = payload.get("action")
        start, end = payload.get("start"), payload.get("end")
        if action not in ACTIONS or action == "idle":
            raise ValueError("请选择一个动作")
        if not self.studio.source_info or payload.get("source_id") != self.studio.source_info["id"]:
            raise ValueError("请先导入视频素材")
        try:
            start, end = float(start), float(end)
        except (TypeError, ValueError):
            raise ValueError("请检查片段起止时间")
        duration = end - start
        if (not math.isfinite(start) or not math.isfinite(end) or start < 0 or
                duration < 0.25 or duration > 120 or end > self.studio.source_info["duration"]):
            raise ValueError("片段需为 0.25–120 秒，并位于原视频范围内")
        if not shutil.which("ffmpeg"):
            raise ValueError("剪辑需要 FFmpeg，请先运行 brew install ffmpeg")
        if not self.studio.clip_lock.acquire(blocking=False):
            raise ValueError("另一个片段正在处理中，请稍后再试")
        file = self.studio.data / "media" / (uuid.uuid4().hex + ".mp4")
        try:
            source = self.studio.source_path
            source_info = dict(self.studio.source_info)
            scale = min(1, 1280 / source_info["width"], 720 / source_info["height"])
            width = max(2, int(source_info["width"] * scale) // 2 * 2)
            height = max(2, int(source_info["height"] * scale) // 2 * 2)
            result = subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.3f}", "-i", str(source),
                "-t", f"{duration:.3f}", "-map", "0:v:0", "-an", "-vf", f"scale={width}:{height}",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart", str(file)], capture_output=True, timeout=240)
            if result.returncode or not file.is_file() or file.stat().st_size > MAX_UPLOAD:
                raise ValueError("本机剪辑失败；请检查视频格式、剩余空间和 FFmpeg")
            probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
                "-of", "json", str(file)], capture_output=True, timeout=15)
            info = json.loads(probe.stdout)
            video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
            clip_duration = float(info.get("format", {}).get("duration", 0))
            if (probe.returncode or not video or video.get("codec_name") != "h264" or
                    not math.isfinite(clip_duration) or not 0.1 <= clip_duration <= 120):
                raise ValueError("生成的视频片段校验失败")
            media = {"url": "/media/" + file.name, "name": clean(source_info["name"], 100) + " · 剪辑",
                "duration": clip_duration, "width": video.get("width"), "height": video.get("height")}
            with self.studio.lock:
                self.studio.media[action] = media
                self.studio.persist("media", self.studio.media)
                self.studio.notify()
            return self.send_json(media)
        except subprocess.TimeoutExpired:
            file.unlink(missing_ok=True)
            raise ValueError("处理超时，请缩短片段后重试")
        except (KeyError, TypeError, json.JSONDecodeError):
            file.unlink(missing_ok=True)
            raise ValueError("视频片段处理失败")
        except ValueError:
            file.unlink(missing_ok=True)
            raise
        finally:
            self.studio.clip_lock.release()

    def upload(self, action, length):
        if action not in ACTIONS or not 0 < length <= MAX_UPLOAD:
            self.close_connection = True
            raise ValueError("素材无效或超过 150 MB")
        suffix = Path(unquote(self.headers.get("X-Filename", ""))).suffix.lower()
        if suffix not in (".mp4", ".webm"):
            self.close_connection = True
            raise ValueError("请选择 MP4 或 WebM 视频")
        if not shutil.which("ffprobe"):
            self.close_connection = True
            raise ValueError("验证视频需要 FFmpeg，请先运行 brew install ffmpeg")
        file = self.studio.data / "media" / (uuid.uuid4().hex + suffix)
        try:
            with file.open("wb") as dest:
                remaining = length
                while remaining:
                    block = self.rfile.read(min(65536, remaining))
                    if not block:
                        raise ValueError("上传中断，请重新选择视频")
                    remaining -= len(block)
                    dest.write(block)
            with file.open("rb") as source:
                header = source.read(32)
            if not ((suffix == ".mp4" and b"ftyp" in header) or
                    (suffix == ".webm" and header.startswith(b"\x1aE\xdf\xa3"))):
                raise ValueError("文件不是有效的 MP4/WebM")
            result = subprocess.run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
                                     "-of", "json", str(file)], capture_output=True, timeout=15)
            info = json.loads(result.stdout)
            video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
            duration = float(info.get("format", {}).get("duration", 0))
            if result.returncode or not video or not math.isfinite(duration) or not 0.1 <= duration <= 120:
                raise ValueError("视频必须包含画面，时长在 0.1–120 秒之间")
            if suffix == ".mp4" and video.get("codec_name") != "h264":
                raise ValueError("MP4 请使用 H.264 编码，保证浏览器可以播放")
            if suffix == ".webm" and video.get("codec_name") not in ("vp8", "vp9", "av1"):
                raise ValueError("WebM 请使用 VP8、VP9 或 AV1 编码")
            media = {"url": "/media/" + file.name, "name": clean(unquote(self.headers.get("X-Filename", "素材")), 100),
                     "duration": duration, "width": video.get("width"), "height": video.get("height")}
            with self.studio.lock:
                self.studio.media[action] = media
                self.studio.persist("media", self.studio.media)
                self.studio.notify()
            self.send_json(media)
        except (ValueError, KeyError, subprocess.TimeoutExpired):
            file.unlink(missing_ok=True)
            raise ValueError("视频校验失败：请使用 0.1–120 秒的 H.264 MP4 或标准 WebM")


def main():
    parser = argparse.ArgumentParser(description="Mac AI Live · 完全本地的虚拟主播工作台")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="打开浏览器")
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        parser.exit(1, f"端口 {args.port} 已被占用。请打开现有工作台，或使用 --port 8766。\n")
    studio = Studio(DATA)
    server.daemon_threads = True
    server.studio = studio
    url = f"http://127.0.0.1:{args.port}"
    print(f"\n  Mac AI Live  v0.9.0\n  工作台 {url}\n  竖屏直播画面 {url}/stage?layout=portrait\n  本地运行 · 不使用 GPU · 按 Ctrl+C 退出\n", flush=True)
    if args.open:
        webbrowser.open(url)
    def stop(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        studio.closed = True
        studio.cancel.set()
        with studio.changed:
            studio.notify()
        server.server_close()


if __name__ == "__main__":
    main()
