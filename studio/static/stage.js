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
    document.querySelector('#stage-message').textContent = '动作素材加载失败，人物静帧仍可使用';
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
  document.querySelector('#mode-badge').textContent = Object.keys(data.media).length ? '本地动作素材' : '原创写实角色 · 静帧演示';
  document.querySelector('#subtitle').textContent = data.config.subtitles ? data.state.text : '';
  document.querySelector('#stage-message').textContent = data.state.phase === 'thinking' ? '看见你的弹幕了…' : '';
  const activeJob = data.state.job_id && data.history.find(job => job.id === data.state.job_id);
  const labels = {
    idle: ['今晚聊什么', '下班后，陪你坐一会儿。', '发一条弹幕；放行后会播放语音和可用的动作素材。'],
    thinking: ['正在看弹幕', '想一想怎么回答…', '当前使用本地规则回答；后续可以替换成模型接口。'],
    action: data.media[data.state.action]
      ? ['正在播放动作', data.state.action === 'eat' ? '小满正在吃一口' : data.state.action === 'drink' ? '小满正在喝水' : '小满正在回应动作', '动作来自你导入的本地视频素材。']
      : data.media.idle
        ? ['待机视频播放中', '还没有对应动作片段', '当前循环播放本地待机视频；导入这项动作的视频后才能看到对应动作。']
        : ['动作素材未就绪', `还没有${data.state.action === 'eat' ? '吃一口' : data.state.action === 'drink' ? '喝水' : data.state.action === 'wave' ? '挥手' : data.state.action === 'laugh' ? '笑一笑' : data.state.action === 'nod' ? '点头' : '对应'}视频`, '当前显示角色静帧；导入这位角色的动作视频后，舞台才能播放连续动作。'],
    speaking: ['正在回应', `${activeJob?.user || '直播间'}，小满回答你`, '声音与字幕同步；人物只有在导入说话视频时才会动。'],
  };
  const [cardLabel, cardTitle, cardDescription] = labels[data.state.phase] || labels.idle;
  document.querySelector('#scene-card-label').textContent = cardLabel;
  document.querySelector('#scene-card-title').textContent = cardTitle;
  document.querySelector('#scene-card-description').textContent = cardDescription;
  document.querySelector('#viewer-name').textContent = activeJob ? `观众 · ${activeJob.user}` : '直播间';
  document.querySelector('#viewer-text').textContent = activeJob ? activeJob.text : '今夜有风，进来坐坐。';
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
