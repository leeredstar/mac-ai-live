'use strict';
const $ = s => document.querySelector(s);
const labels = {idle:'待机',talk:'说话',eat:'吃一口',drink:'喝水',wave:'挥手',laugh:'笑一笑',nod:'点头'};
const icons = {idle:'✳',talk:'☏',eat:'🍪',drink:'☕',wave:'👋',laugh:'☺',nod:'✓'};
const descriptions = {idle:'自然呼吸、看向镜头。循环播放。',talk:'轻微说话动作。循环播放，不生成实时口型。',eat:'拿起食物、吃一口，再回到待机姿势。',drink:'拿起杯子、喝水、放下杯子。',wave:'向观众打个招呼。',laugh:'一个轻松、自然的笑容。',nod:'认真听到后的回应。'};
const poseUrls = {eat:'/static/character-actions/eat.jpg',drink:'/static/character-actions/drink.jpg',wave:'/static/character-actions/wave-a.jpg',laugh:'/static/character-actions/laugh.jpg',nod:'/static/character-actions/nod.jpg'};
const statuses = {queued:'已放行',pending:'待审核',active:'表演中',done:'已完成',cancelled:'已取消',rejected:'已跳过',failed:'失败'};
let latest = null, settingsLoaded = false, assetSignature = '', toastTimer, sourceAsset = null;
function el(tag, cls, text) { const node = document.createElement(tag); if(cls) node.className = cls; if(text !== undefined) node.textContent = text; return node; }
function toast(text, error=false) { const node=$('#toast'); node.textContent=text; node.className='toast visible'+(error?' error':''); clearTimeout(toastTimer); toastTimer=setTimeout(()=>node.classList.remove('visible'),4000); }
async function api(path, payload) {
  const response = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data = await response.json(); if(!response.ok) throw new Error(data.error || '操作失败'); return data;
}
async function attempt(fn) { try { return await fn(); } catch(error) { toast(error.message || '连接失败，请检查工作台是否运行',true); return null; } }
function setTab(tab) {
  document.querySelectorAll('.tab-panel').forEach(panel=>panel.classList.toggle('hidden',panel.id!=='panel-'+tab));
  document.querySelectorAll('.nav-item').forEach(button=>button.classList.toggle('selected',button.dataset.tab===tab));
  const titles={control:['直播工作台','让每一条弹幕，都有回应。','先排练弹幕、动作和语音，再准备直播素材。'],assets:['角色与动作','为她，准备一点生活感。','导入同一人物的动作视频；没有视频时照片保持静止。'],settings:['声音与回答','熟悉的声音，舒服的节奏。','先用离线演示排练，后续再接入你选择的模型。'],companion:['抖音直播伴侣','让本地舞台，进入直播预览。','跟着步骤完成窗口采集；先检查画面和声音，再由账号所有者确认开播。']};
  $('#page-label').textContent=titles[tab][0];$('#heading').textContent=titles[tab][1];$('#description').textContent=titles[tab][2];
}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>setTab(button.dataset.tab)));
$('#sample').addEventListener('click',()=>{$('#comment').value='小满，吃一口饼干，再跟我打个招呼吧！';$('#comment').focus();});
$('#comment-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;
  const result=await attempt(()=>api('/api/comments',{user:$('#viewer').value,text:$('#comment').value}));
  if(result){$('#comment').value='';toast(result.status==='pending'?'已加入队列，点击“放行”后表演':'已加入表演队列');}button.disabled=false;
});
document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',async()=>{
  const action=button.dataset.action;button.disabled=true;
  try{
    if(!latest.running)await api('/api/control',{command:'start'});
    const job=await api('/api/comments',{user:'场控',text:labels[action]+'，和大家互动一下',action});
    if(job.status==='pending')await api('/api/control',{command:'approve',id:job.id});
    toast(latest?.media?.[action]?'动作视频已开始播放。':`已切换到“${labels[action]}”静态姿势；还没有连续动作视频。`);
  }catch(error){toast(error.message||'动作没有启动，请检查工作台状态',true);}
  button.disabled=false;
}));
$('#toggle-run').addEventListener('click',()=>attempt(()=>api('/api/control',{command:latest?.running?'pause':'start'})));
$('#interrupt').addEventListener('click',()=>attempt(()=>api('/api/control',{command:'interrupt'})));
$('#clear').addEventListener('click',()=>attempt(()=>api('/api/control',{command:'clear'})));
$('#queue').addEventListener('click',event=>{const button=event.target.closest('[data-command]');if(button)attempt(()=>api('/api/control',{command:button.dataset.command,id:button.dataset.id}));});
function renderQueue(data) {
  const container=$('#queue'); const signature=JSON.stringify(data.queue);
  if(container.dataset.signature===signature)return;
  container.dataset.signature=signature;
  if(!data.queue.length) {
    const empty=el('div','empty queue-empty');empty.append(el('span','','✳'),el('strong','','舞台已经准备好'),el('p','','发送一条弹幕，或者点击下方示例。'));
    const button=el('button','text-button','填入一条示例 →');button.addEventListener('click',()=>{$('#comment').value='小满，吃一口饼干吧！';$('#comment').focus();});empty.append(button);container.replaceChildren(empty);return;
  }
  const nodes=data.queue.map(job=>{
    const node=el('article','queue-item');const header=el('header');header.append(el('span','',job.user),el('span','',new Date(job.created*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})));
    const footer=el('footer');footer.append(el('span','',icons[job.action]+' '+labels[job.action]));const controls=el('div');
    if(job.status==='pending'){const approve=el('button','approve','放行');approve.dataset.command='approve';approve.dataset.id=job.id;controls.append(approve);}else controls.append(el('span','','已放行 · 等候表演 '));
    const reject=el('button','reject','跳过');reject.dataset.command='reject';reject.dataset.id=job.id;controls.append(reject);footer.append(controls);node.append(header,el('p','',job.text),footer);return node;
  });container.replaceChildren(...nodes);
}
function renderHistory(data){
  const signature=JSON.stringify(data.history);if($('#history').dataset.signature===signature)return;$('#history').dataset.signature=signature;
  const jobs=data.history.filter(j=>!['pending','queued'].includes(j.status)).slice(0,12);
  if(!jobs.length){$('#history').replaceChildren(el('div','empty','排练开始后，互动记录会留在这里。'));return;}
  $('#history').replaceChildren(...jobs.map(job=>{const row=el('div','history-row');const text=el('div','history-text');text.append(el('strong','',job.user+' · '+job.text),el('p','',job.error||job.reply||'正在准备动作和语音…'));row.append(el('span','history-icon',icons[job.action]),text,el('span','history-status '+job.status,statuses[job.status]));return row;}));
}
function renderAssets(data){
  const signature=JSON.stringify(data.media);if(assetSignature===signature)return;assetSignature=signature;
  $('#asset-count').textContent=Object.keys(data.media).length;
  $('#asset-grid').replaceChildren(...Object.keys(labels).map(action=>{
    const media=data.media[action];const card=el('article','asset-card');card.id=`asset-${action}`;const visual=el('div','asset-visual');
    if(media){const video=el('video');video.src=media.url;video.muted=true;video.controls=true;video.preload='metadata';visual.append(video);}else{visual.classList.add('asset-still-preview');const still=el('img');still.src=poseUrls[action]||'/static/character-xiaoman-v2-thumb.jpg';still.alt=poseUrls[action]?`原创虚拟角色${labels[action]}的离线姿态演示画面`:`原创虚拟角色静帧参考；尚未导入${labels[action]}动作视频`;still.loading='eager';still.decoding='async';visual.append(still,el('span','still-badge',poseUrls[action]?'内置姿态演示 · 非连续视频':'静帧预览 · 无动作视频'));}
    const controls=el('div','asset-controls');const upload=el('button','button',media?'替换视频':'导入视频');upload.type='button';const file=el('input','hidden');file.type='file';file.accept='video/mp4,video/webm';file.setAttribute('aria-label','导入'+labels[action]+'视频');
    upload.addEventListener('click',()=>file.click());file.addEventListener('change',async()=>{
      const source=file.files[0];if(!source)return;if(source.size>150*1024*1024){toast('视频不能超过 150 MB',true);return;}
      upload.disabled=true;upload.textContent='导入中…';
      await attempt(async()=>{const response=await fetch('/api/media/'+action,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(source.name)},body:source});const result=await response.json();if(!response.ok)throw new Error(result.error);toast(labels[action]+'素材已保存到本机');});
      upload.disabled=false;upload.textContent=media?'替换视频':'导入视频';file.value='';
    });controls.append(upload,file);
    if(media){const remove=el('button','text-button','恢复示例');remove.type='button';remove.addEventListener('click',()=>attempt(()=>api('/api/media/remove',{action})));controls.append(remove);}
    card.append(visual,el('h3','',labels[action]),el('p','',descriptions[action]),el('div','asset-filename',media?`${media.name} · ${media.duration.toFixed(1)} 秒`:poseUrls[action]?'内置静态姿势示意 · 非连续动作':'尚未导入素材'),controls);return card;
  }));
}
function updateClipForm(){
  const start=Number($('#clip-start').value),end=Number($('#clip-end').value);
  $('#clip-save').disabled=!sourceAsset||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end-start<.25||end-start>120||end>sourceAsset.duration;
}
function showSource(source){
  sourceAsset=source;const video=$('#source-video');
  if(source){video.src=source.url;video.classList.add('has-source');$('#source-status').textContent=`${source.name} · ${source.duration.toFixed(1)} 秒`;$('#source-remove').classList.remove('hidden');$('#clip-start').value='0';$('#clip-end').value=Math.min(3,source.duration).toFixed(1);}
  else{video.pause();video.removeAttribute('src');video.load();video.classList.remove('has-source');$('#source-status').textContent='MP4 或 WebM，最长 30 分钟、150 MB';$('#source-remove').classList.add('hidden');}
  updateClipForm();
}
$('#source-pick').addEventListener('click',()=>$('#source-file').click());
$('#source-file').addEventListener('change',async()=>{
  const source=$('#source-file').files[0];if(!source)return;
  if(source.size>150*1024*1024){toast('视频不能超过 150 MB',true);$('#source-file').value='';return;}
  const button=$('#source-pick');button.disabled=true;button.textContent='正在导入…';$('#clip-save').disabled=true;
  const result=await attempt(async()=>{const response=await fetch('/api/source',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(source.name)},body:source});const data=await response.json();if(!response.ok)throw new Error(data.error||'导入失败');return data;});
  if(result){showSource(result);toast('原视频已保存在本机，可以开始标记片段');}
  button.disabled=false;button.textContent='选择原视频';$('#source-file').value='';updateClipForm();
});
$('#source-remove').addEventListener('click',async()=>{const result=await attempt(()=>api('/api/source/remove',{}));if(result)showSource(null);});
document.querySelectorAll('[data-mark]').forEach(button=>button.addEventListener('click',()=>{if(!sourceAsset)return;const field=$('#clip-'+button.dataset.mark);field.value=$('#source-video').currentTime.toFixed(1);updateClipForm();}));
$('#clip-start').addEventListener('input',updateClipForm);$('#clip-end').addEventListener('input',updateClipForm);
$('#clip-save').addEventListener('click',async()=>{
  if(!sourceAsset)return;const action=$('#clip-action').value,button=$('#clip-save');button.disabled=true;button.textContent='本机正在剪辑…';
  const result=await attempt(()=>api('/api/media/clip',{source_id:sourceAsset.id,action,start:$('#clip-start').value,end:$('#clip-end').value}));
  if(result){assetSignature='';if(latest){latest.media[action]=result;renderAssets(latest);}toast(labels[action]+'动作片段已生成并保存到本机');}
  button.textContent='剪成动作片段';updateClipForm();
});
function fillSettings(config){Object.entries(config).forEach(([key,value])=>{const field=$('#setting-'+key);if(!field)return;if(field.type==='checkbox')field.checked=value;else field.value=value;});updateSettingLabels();settingsLoaded=true;}
function updateSettingLabels(){$('#rate-label').textContent=$('#setting-rate').value+' 字/分钟';$('#volume-label').textContent=Math.round($('#setting-volume').value*100)+'%';$('#ollama-fields').classList.toggle('hidden',$('#setting-engine').value!=='ollama');}
$('#settings-form').addEventListener('input',updateSettingLabels);
$('#settings-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;const values={};new FormData(event.target).forEach((value,key)=>values[key]=value);['subtitles','auto_approve'].forEach(key=>values[key]=$('#setting-'+key).checked);values.rate=Number(values.rate);values.volume=Number(values.volume);const result=await attempt(()=>api('/api/settings',values));if(result)toast('设置已保存在这台 Mac');button.disabled=false;});
function renderMediaReadiness(data){const count=Object.keys(data.media).length;const demoCount=Object.keys(poseUrls).length;$('#readiness-title').textContent=`静态姿势示意 ${demoCount}/5 · 连续动作视频 ${count}/7`;$('#readiness-copy').textContent=count===0?'当前点击只切换到对应姿势，不会出现连续动作。导入同一角色的本地动作视频后，舞台才会播放挥手、吃喝等连贯动作。':`已导入 ${count} 项视频；缺少动作视频的按钮只显示静态姿势示意。`;document.querySelectorAll('[data-action]').forEach(button=>{const action=button.dataset.action;const ready=Boolean(data.media[action]);const hasPose=Boolean(poseUrls[action]);button.classList.toggle('ready-media',ready);button.classList.toggle('ready-demo',!ready&&hasPose);button.classList.toggle('missing-media',!ready&&!hasPose);button.querySelector('.action-media-status').textContent=ready?`视频已就绪 · ${data.media[action].duration.toFixed(1)} 秒`:hasPose?'静态姿势':'缺少视频';button.title=ready?'点击播放这项本地动作视频':hasPose?`点击只显示${labels[action]}静态姿势；连续动作需导入本地视频`:`未导入${labels[action]}动作视频。`;});}
function render(data){latest=data;const canClip=Boolean(data.capabilities?.clipper);$('#version-label').textContent=data.capabilities?.version?'v'+data.capabilities.version+' · 静态姿势预览':'旧版服务 · 需重启后排练';$('#asset-workflow-note').textContent=canClip?'无动作视频时，动作按钮只显示静态姿势示意；导入同一角色的视频后，舞台优先播放连续素材。也可从一条长视频剪出多个动作。':'无动作视频时，动作按钮只显示静态姿势示意；分别导入同一人物的短视频即可替换演示画面。';$('#clipper-card').classList.toggle('hidden',!canClip);$('#connection').textContent='本机已连接';$('#connection-dot').classList.remove('error');$('#queue-count').textContent=data.queue.length;$('#pending-hint').textContent=data.config.auto_approve?'自动放行':'手动放行';$('#toggle-run').textContent=data.running?'Ⅱ 暂停排练':'▶ 开始排练';$('#run-dot').classList.toggle('active',data.running);$('#run-label').textContent=data.running?'排练进行中':'排练已暂停';$('#preview-state').textContent={idle:'待机中',thinking:'准备回答',action:'正在'+labels[data.state.action],speaking:'正在互动'}[data.state.phase];$('#description').title=data.config.engine==='rules'?'当前使用规则演示，非通用 AI 问答':'当前使用本地 Ollama';if(!settingsLoaded)fillSettings(data.config);renderMediaReadiness(data);renderQueue(data);renderHistory(data);renderAssets(data);}
const stream=new EventSource('/api/events');stream.onmessage=event=>{try{render(JSON.parse(event.data));}catch(error){console.error(error);toast('界面更新失败，请刷新',true);}};stream.onerror=()=>{$('#connection').textContent='本机连接中断，正在重连';$('#connection-dot').classList.add('error');};
addEventListener('pagehide',()=>stream.close());
