'use strict';
const preview = new URLSearchParams(location.search).has('preview');
const layout = new URLSearchParams(location.search).get('layout');
const silentTestMode = new URLSearchParams(location.search).has('silent-test');
const portraitMode = layout === 'portrait';
document.body.dataset.layout = portraitMode ? 'portrait' : 'landscape';
const speech = document.querySelector('#speech');
const enable = document.querySelector('#enable-audio');
const mute = document.querySelector('#mute-audio');
const avatarPhoto = document.querySelector('#avatar-photo');
const blinkLayer = document.querySelector('.blink-layer');
const mouthLayer = document.querySelector('.mouth-layer');
const videos = [document.querySelector('#video-a'), document.querySelector('#video-b')];
const poseStack = document.querySelector('#pose-stack');
const poseFrame = document.querySelector('#pose-frame');
const faceMotion = document.querySelector('#face-motion');
const waveFrames = [document.querySelector('#pose-wave-a'), document.querySelector('#pose-wave-b')];
const landscapePoses = {talk:'/static/character-actions/xiaoman-v3-talk.jpg',eat:'/static/character-actions/xiaoman-v3-eat.jpg',drink:'/static/character-actions/xiaoman-v3-drink.jpg',wave:['/static/character-actions/xiaoman-v3-wave-a.jpg','/static/character-actions/xiaoman-v3-wave-b.jpg'],laugh:'/static/character-actions/xiaoman-v3-laugh.jpg',nod:'/static/character-actions/xiaoman-v3-nod.jpg'};
const portraitPoses = {talk:'/static/character-actions/xiaoman-v4-talk.jpg',eat:'/static/character-actions/xiaoman-v4-eat.jpg',drink:'/static/character-actions/xiaoman-v4-drink.jpg',wave:['/static/character-actions/xiaoman-v4-wave-a.jpg','/static/character-actions/xiaoman-v4-wave-b.jpg'],laugh:'/static/character-actions/xiaoman-v4-laugh.jpg',nod:'/static/character-actions/xiaoman-v4-nod.jpg'};
const poses = portraitMode ? portraitPoses : landscapePoses;
if (portraitMode) {
  avatarPhoto.src = '/static/character-xiaoman-v4-portrait.jpg';
  blinkLayer.src = '/static/character-actions/xiaoman-v4-blink.jpg';
  mouthLayer.src = '/static/character-actions/xiaoman-v4-talk.jpg';
}
let sound = false, latest = null, activeVideo = 0, visualKey = '', poseKey = '', waveTimer = null, waveIndex = 0, soundKey = '', videoGeneration = 0, blinkTimer = null, blinkResetTimer = null, blinkMode = '';
let audioContext = null, audioAnalyser = null, audioSource = null, audioOutputGain = null, mouthFrame = null;
Object.values(poses).flat().forEach(url => { const preload = new Image(); preload.src = url; });
if (portraitMode) ['/static/character-actions/xiaoman-v4-blink.jpg', '/static/character-actions/xiaoman-v4-talk.jpg'].forEach(url => { const preload = new Image(); preload.src = url; });
function stopMouthTracking() {
  if (mouthFrame !== null) cancelAnimationFrame(mouthFrame);
  mouthFrame = null;
  mouthLayer.style.opacity = '0';
}
function trackMouthEnergy() {
  if (!portraitMode || !audioAnalyser || !sound || speech.paused || speech.ended) {
    stopMouthTracking();
    return;
  }
  const samples = new Uint8Array(audioAnalyser.fftSize);
  audioAnalyser.getByteTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) { const centered = (sample - 128) / 128; sum += centered * centered; }
  const rms = Math.sqrt(sum / samples.length);
  const target = Math.min(.88, .055 + Math.max(0, rms - .012) * 4.6);
  const current = Number(mouthLayer.style.opacity) || .055;
  mouthLayer.style.opacity = (current + (target - current) * (target > current ? .42 : .2)).toFixed(3);
  mouthFrame = requestAnimationFrame(trackMouthEnergy);
}
async function prepareAudioGraph() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!portraitMode || !AudioContextClass) return false;
  if (!audioContext) {
    audioContext = new AudioContextClass();
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 512;
    audioOutputGain = audioContext.createGain();
    audioOutputGain.gain.value = silentTestMode ? 0 : 1;
    audioSource = audioContext.createMediaElementSource(speech);
    audioSource.connect(audioAnalyser);
    audioAnalyser.connect(audioOutputGain);
    audioOutputGain.connect(audioContext.destination);
  }
  if (audioContext.state !== 'running') await audioContext.resume();
  return audioContext.state === 'running';
}
speech.addEventListener('ended', stopMouthTracking);
speech.addEventListener('pause', stopMouthTracking);
function clearBlinkTimers() { clearTimeout(blinkTimer); clearTimeout(blinkResetTimer); blinkTimer = null; blinkResetTimer = null; faceMotion.classList.remove('blinking'); }
function scheduleBlink() {
  if (blinkMode !== 'idle') return;
  blinkTimer = setTimeout(() => {
    if (blinkMode !== 'idle') return;
    faceMotion.classList.add('blinking');
    blinkResetTimer = setTimeout(() => { faceMotion.classList.remove('blinking'); scheduleBlink(); }, 145);
  }, 2600 + Math.random() * 3200);
}
function updateFaceMotion(data) {
  const state = data.state;
  const slot = state.phase === 'speaking' || state.phase === 'action' ? state.action : 'idle';
  const hasVideo = Boolean(data.media[slot] || (slot !== 'idle' && data.media.idle));
  document.body.dataset.videoActive = hasVideo ? 'true' : 'false';
  const nextBlinkMode = !hasVideo && ['idle', 'thinking', 'action', 'speaking'].includes(state.phase) ? 'idle' : 'none';
  if (nextBlinkMode !== blinkMode) {
    clearBlinkTimers(); blinkMode = nextBlinkMode;
    if (blinkMode === 'idle') scheduleBlink();
  }
}
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
    speech.play().then(() => {
      if (portraitMode && audioAnalyser) { stopMouthTracking(); mouthFrame = requestAnimationFrame(trackMouthEnergy); }
    }).catch(() => {
      sound = false; soundKey = ''; enable.classList.remove('hidden');
      stopMouthTracking();
      enable.textContent = '浏览器暂停了声音 · 点击恢复';
    });
  };
}
function soundOff() {
  sound = false; speech.pause(); soundKey = '';
  stopMouthTracking();
  if (releaseSoundLock) releaseSoundLock();
  releaseSoundLock = null;
  mute.classList.add('hidden'); enable.classList.remove('hidden');
  enable.textContent = '♫ 启用声音 · 开始观看';
}
enable.addEventListener('click', async () => {
  // Unlock HTML audio during the user gesture, without speaking outside this tab.
  const unlock = new Audio('data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQEAAAAA');
  unlock.play().catch(() => {});
  if (portraitMode) { try { await prepareAudioGraph(); } catch (error) { console.warn('声音分析不可用，保持正常语音播放', error); } }
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
  const selectedMedia = data.media[slot];
  const media = selectedMedia || (slot !== 'idle' ? data.media.idle : null);
  const hasActionClip = state.phase === 'action' && Boolean(data.media[state.action]);
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
  // Loop an idle fallback while the static action pose sits above it. Only a
  // dedicated action clip should stop at its own end.
  video.loop = state.phase !== 'action' || !hasActionClip;
  video.muted = true; video.src = media.url; video.load();
}
function updatePose(data) {
  const state = data.state;
  const action = state.action;
  const poseAction = state.phase === 'speaking' ? 'talk' : action;
  const canShowPose = state.phase === 'action' || state.phase === 'speaking';
  // An idle loop is not an action/talk clip: keep the matching pose above it.
  const hasIdleSpeechFallback = state.phase === 'speaking' && !data.media.talk && Boolean(data.media.idle);
  const pose = canShowPose && !data.media[poseAction]
    && (poseAction !== 'talk' || hasIdleSpeechFallback) ? poses[poseAction] : null;
  const key = pose ? `${state.job_id || ''}:${poseAction}:${state.start}` : '';
  if (key === poseKey) return;
  poseKey = key;
  if (waveTimer) clearInterval(waveTimer);
  waveTimer = null;
  poseStack.classList.remove('active','speaking');
  poseStack.removeAttribute('data-action');
  poseStack.style.removeProperty('--action-duration');
  poseFrame.removeAttribute('src');
  poseFrame.classList.remove('active');
  waveFrames.forEach(frame => { frame.classList.remove('active'); frame.removeAttribute('src'); });
  if (!pose) return;
  poseStack.dataset.action = poseAction;
  poseStack.style.setProperty('--action-duration', `${Math.max(1, Number(state.duration) || 2)}s`);
  if (poseAction === 'talk') {
    poseFrame.src = pose;
    poseFrame.classList.add('active');
    poseStack.classList.add('active','speaking');
  } else if (poseAction === 'wave') {
    const frames = poses.wave;
    waveIndex = 0;
    waveFrames.forEach((frame, index) => frame.src = frames[index]);
    waveFrames[0].classList.add('active');
    poseStack.classList.add('active');
    waveTimer = setInterval(() => {
      waveFrames[waveIndex].classList.remove('active');
      waveIndex = 1 - waveIndex;
      waveFrames[waveIndex].classList.add('active');
    }, 430);
  } else {
    poseFrame.src = pose;
    poseFrame.classList.add('active');
    poseStack.classList.add('active');
  }
}
function render(data) {
  data.clockOffset = data.server_time - Date.now() / 1000;
  latest = data;
  document.body.dataset.action = data.state.action;
  document.body.dataset.phase = data.state.phase;
  document.querySelector('#stage-name').textContent = data.config.name + '的片刻';
  const poseAction = data.state.phase === 'speaking' ? 'talk' : data.state.action;
  const hasBuiltInPose = (data.state.phase === 'action' || data.state.phase === 'speaking')
    && poses[poseAction] && !data.media[poseAction];
  const selectedMedia = data.state.phase === 'action' || data.state.phase === 'speaking'
    ? data.media[poseAction]
    : data.media.idle;
  document.querySelector('#mode-badge').textContent = selectedMedia
    ? (data.state.phase === 'action' ? '本地动作视频' : data.state.phase === 'speaking' ? '本地说话视频' : '本地待机视频')
    : data.state.phase === 'speaking' && !data.media.talk && !data.media.idle ? (portraitMode ? '语音联动嘴部 · 非音素同步' : '轻量口型动画 · 非音素同步')
      : hasBuiltInPose ? (data.state.phase === 'speaking' ? (portraitMode ? '声音联动口型 · 非音素同步' : '说话姿势 · 无实时口型') : '预制姿势 · 非连续动作') : data.media.idle ? '本地待机视频' : portraitMode ? '原创角色 · 竖屏写实待机图' : '原创角色 · 预制待机图';
  document.querySelector('#subtitle').textContent = data.config.subtitles ? data.state.text : '';
  document.querySelector('#stage-message').textContent = data.state.phase === 'thinking' ? '看见你的弹幕了…' : '';
  const activeJob = data.state.job_id && data.history.find(job => job.id === data.state.job_id);
  const labels = {
    idle: ['今晚聊什么', '下班后，陪你坐一会儿。', '发一条弹幕；放行后会播放语音和可用的动作素材。'],
    thinking: ['正在看弹幕', '想一想怎么回答…', '当前使用本地规则回答；后续可以替换成模型接口。'],
    action: data.media[data.state.action]
      ? ['正在播放动作', data.state.action === 'eat' ? '小满正在吃一口' : data.state.action === 'drink' ? '小满正在喝水' : data.state.action === 'wave' ? '小满正在挥手' : data.state.action === 'laugh' ? '小满笑了一下' : '小满点了点头', '动作来自你导入的本地视频素材。']
      : poses[data.state.action]
        ? ['预制姿势画面', data.state.action === 'eat' ? '吃一口 · 饼干姿势' : data.state.action === 'drink' ? '喝水 · 拿杯姿势' : data.state.action === 'wave' ? '挥手 · 双帧招呼' : data.state.action === 'laugh' ? '微笑 · 读到有趣的弹幕' : '点头 · 低头回应弹幕', '这是同一原创角色的预制画面，不是连续视频。导入本地动作视频后才会展示连贯运动。']
        : data.media.idle
          ? ['待机视频播放中', '还没有对应动作片段', '当前循环播放本地待机视频；导入这项动作的视频后可播放对应动作。']
          : ['正在准备回答', '马上回应这条弹幕', '台词由本机规则或你选用的本地模型生成。'],
    speaking: ['正在回应', `${activeJob?.user || '直播间'}，小满回答你`, data.media.talk ? '正在播放本地说话视频。' : data.media.idle ? '待机视频上显示单帧说话姿势；声音和字幕同步，口型由素材决定。' : portraitMode ? '嘴部开合会跟随本地语音强弱变化；不做音素级口型。' : '嘴部会随语音轻微开合；这是预制表情节奏，不按音素同步。'],
  };
  const [cardLabel, cardTitle, cardDescription] = labels[data.state.phase] || labels.idle;
  document.querySelector('#scene-card-label').textContent = cardLabel;
  document.querySelector('#scene-card-title').textContent = cardTitle;
  document.querySelector('#scene-card-description').textContent = cardDescription;
  document.querySelector('#viewer-name').textContent = activeJob ? `观众 · ${activeJob.user}` : '直播间';
  document.querySelector('#viewer-text').textContent = activeJob ? activeJob.text : '今夜有风，进来坐坐。';
  speech.volume = data.config.volume;
  updateFaceMotion(data); updateVideo(data); updatePose(data); playSpeech(data);
  document.querySelector('#stage-connection').textContent = 'LOCAL · OFFLINE';
}
const stream = new EventSource('/api/events');
stream.onmessage = event => { try { render(JSON.parse(event.data)); } catch (error) { console.error('画面更新失败', error); } };
stream.onerror = () => {
  speech.pause(); soundKey = '';
  videos.forEach(v => v.pause()); visualKey = ''; ++videoGeneration;
  if (waveTimer) clearInterval(waveTimer);
  waveTimer = null; poseKey = ''; poseStack.classList.remove('active'); stopMouthTracking();
  clearBlinkTimers(); blinkMode = '';
  document.body.dataset.action = 'idle'; document.body.dataset.phase = 'idle';
  document.querySelector('#subtitle').textContent = '';
  document.querySelector('#stage-message').textContent = '工作台连接中断，等待恢复';
  document.querySelector('#stage-connection').textContent = 'RECONNECTING';
};
addEventListener('pagehide', () => { soundOff(); stream.close(); clearBlinkTimers(); });
