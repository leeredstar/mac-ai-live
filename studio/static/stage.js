'use strict';
const preview = new URLSearchParams(location.search).has('preview');
const speech = document.querySelector('#speech');
const enable = document.querySelector('#enable-audio');
const mute = document.querySelector('#mute-audio');
const videos = [document.querySelector('#video-a'), document.querySelector('#video-b')];
let sound = false, latest = null, activeVideo = 0, visualKey = '', soundKey = '', videoGeneration = 0;
let releaseSoundLock = null;
if (preview) enable.classList.add('hidden');
function playSpeech(data) {
  const state = data.state;
  const key = state.audio || '';
  if (key === soundKey) return;
  soundKey = key;
  speech.pause();
  speech.removeAttribute('src');
  if (!sound || state.phase !== 'speaking' || !key) return;
  const elapsed = Math.max(0, Date.now() / 1000 - state.start - (data.clockOffset || 0));
  speech.src = key;
  speech.volume = data.config.volume;
  speech.onloadedmetadata = () => {
    if (soundKey !== key || !sound || elapsed >= speech.duration) return;
    speech.currentTime = Math.min(elapsed, Math.max(0, speech.duration - .1));
    speech.play().catch(() => {
      sound = false; soundKey = ''; enable.classList.remove('hidden');
      enable.textContent = '浏览器暂停了声音 · 点击恢复';
    });
  };
}
function soundOff() {
  sound = false; speech.pause(); soundKey = '';
  if (releaseSoundLock) releaseSoundLock();
  releaseSoundLock = null;
  mute.classList.add('hidden'); enable.classList.remove('hidden');
  enable.textContent = '♫ 启用声音 · 开始观看';
}
enable.addEventListener('click', async () => {
  // Unlock HTML audio during the user gesture, without speaking outside this tab.
  const unlock = new Audio('data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQEAAAAA');
  unlock.play().catch(() => {});
  if (navigator.locks) {
    navigator.locks.request('mac-ai-live-audio', {ifAvailable: true}, async lock => {
      if (!lock) { enable.textContent = '另一个直播窗口正在播放声音'; return; }
      sound = true; soundKey = ''; enable.classList.add('hidden'); mute.classList.remove('hidden');
      if (latest) playSpeech(latest);
      await new Promise(resolve => { releaseSoundLock = resolve; });
    });
  } else {
    sound = true; soundKey = ''; enable.classList.add('hidden'); mute.classList.remove('hidden');
    if (latest) playSpeech(latest);
  }
});
mute.addEventListener('click', soundOff);
function updateVideo(data) {
  const state = data.state;
  const slot = state.phase === 'speaking' ? state.action : state.phase === 'action' ? state.action : 'idle';
  const media = data.media[slot] || (slot !== 'idle' ? data.media.idle : null);
  const key = media ? `${media.url}:${state.job_id || ''}:${state.phase}` : '';
  if (key === visualKey) return;
  visualKey = key;
  const generation = ++videoGeneration;
  if (!media) {
    videos.forEach(video => { video.classList.remove('active'); video.pause(); video.removeAttribute('src'); video.load(); });
    return;
  }
  const next = 1 - activeVideo;
  const video = videos[next];
  video.onloadeddata = () => {
    if (generation !== videoGeneration) return;
    const elapsed = Math.max(0, Date.now() / 1000 - state.start - (data.clockOffset || 0));
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = video.loop ? elapsed % video.duration : Math.min(elapsed, Math.max(0, video.duration - .05));
    }
    video.play().then(() => {
      if (generation !== videoGeneration) { video.pause(); return; }
      video.classList.add('active');
      videos[activeVideo].classList.remove('active'); videos[activeVideo].pause(); activeVideo = next;
    }).catch(() => { document.querySelector('#stage-message').textContent = '视频无法自动播放，请检查素材编码'; });
  };
  video.onerror = () => {
    if (generation !== videoGeneration) return;
    videos.forEach(v => { v.classList.remove('active'); v.pause(); });
    document.querySelector('#stage-message').textContent = '素材加载失败，正在显示动画示例';
  };
  video.loop = state.phase !== 'action';
  video.muted = true; video.src = media.url; video.load();
}
function render(data) {
  data.clockOffset = data.server_time - Date.now() / 1000;
  latest = data;
  document.body.dataset.action = data.state.action;
  document.body.dataset.phase = data.state.phase;
  document.querySelector('#stage-name').textContent = data.config.name + '的片刻';
  document.querySelector('#mode-badge').textContent = Object.keys(data.media).length ? '本地素材驱动' : '本地动画演示';
  document.querySelector('#subtitle').textContent = data.config.subtitles ? data.state.text : '';
  document.querySelector('#stage-message').textContent = data.state.phase === 'thinking' ? '看见你的弹幕了…' : '';
  speech.volume = data.config.volume;
  updateVideo(data); playSpeech(data);
  document.querySelector('#stage-connection').textContent = 'LOCAL · OFFLINE';
}
const stream = new EventSource('/api/events');
stream.onmessage = event => { try { render(JSON.parse(event.data)); } catch (error) { console.error('画面更新失败', error); } };
stream.onerror = () => {
  speech.pause(); soundKey = '';
  videos.forEach(v => v.pause()); visualKey = ''; ++videoGeneration;
  document.body.dataset.action = 'idle'; document.body.dataset.phase = 'idle';
  document.querySelector('#subtitle').textContent = '';
  document.querySelector('#stage-message').textContent = '工作台连接中断，等待恢复';
  document.querySelector('#stage-connection').textContent = 'RECONNECTING';
};
addEventListener('pagehide', () => { soundOff(); stream.close(); });
