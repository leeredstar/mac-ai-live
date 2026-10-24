'use strict';
const $ = s => document.querySelector(s);
const labels = {idle:'待机',talk:'说话',eat:'吃一口',drink:'喝水',wave:'挥手',laugh:'笑一笑',nod:'点头'};
const icons = {idle:'✳',talk:'☏',eat:'🍪',drink:'☕',wave:'👋',laugh:'☺',nod:'✓'};
const descriptions = {idle:'自然呼吸、看向镜头。循环播放。',talk:'轻微说话动作。循环播放，不生成实时口型。',eat:'拿起食物、吃一口，再回到待机姿势。',drink:'拿起杯子、喝水、放下杯子。',wave:'向观众打个招呼。',laugh:'一个轻松、自然的笑容。',nod:'认真听到后的回应。'};
const statuses = {queued:'已放行',pending:'待审核',active:'表演中',done:'已完成',cancelled:'已取消',rejected:'已跳过',failed:'失败'};
let latest = null, settingsLoaded = false, assetSignature = '', toastTimer;
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
  const titles={control:['直播工作台','让每一条弹幕，都有回应。','先在这里排练，再把你喜欢的角色带进直播间。'],assets:['角色与动作','为她，准备一点生活感。','用你自己的角色素材，替换原创示例动画。'],settings:['声音与回答','熟悉的声音，舒服的节奏。','先用离线演示排练，后续再接入你选择的模型。']};
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
  const result=await attempt(()=>api('/api/comments',{user:'场控',text:labels[action]+'，和大家互动一下',action}));
  if(result)toast(result.status==='pending'?'动作已加入待审队列':'动作已加入表演队列');button.disabled=false;
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
    const media=data.media[action];const card=el('article','asset-card');const visual=el('div','asset-visual');
    if(media){const video=el('video');video.src=media.url;video.muted=true;video.controls=true;video.preload='metadata';visual.append(video);}else visual.append(el('span','',icons[action]),el('small','','使用内置动画'));
    const controls=el('div','asset-controls');const upload=el('button','button',media?'替换视频':'导入视频');upload.type='button';const file=el('input','hidden');file.type='file';file.accept='video/mp4,video/webm';file.setAttribute('aria-label','导入'+labels[action]+'视频');
    upload.addEventListener('click',()=>file.click());file.addEventListener('change',async()=>{
      const source=file.files[0];if(!source)return;if(source.size>150*1024*1024){toast('视频不能超过 150 MB',true);return;}
      upload.disabled=true;upload.textContent='导入中…';
      await attempt(async()=>{const response=await fetch('/api/media/'+action,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(source.name)},body:source});const result=await response.json();if(!response.ok)throw new Error(result.error);toast(labels[action]+'素材已保存到本机');});
      upload.disabled=false;upload.textContent=media?'替换视频':'导入视频';file.value='';
    });controls.append(upload,file);
    if(media){const remove=el('button','text-button','恢复示例');remove.type='button';remove.addEventListener('click',()=>attempt(()=>api('/api/media/remove',{action})));controls.append(remove);}
    card.append(visual,el('h3','',labels[action]),el('p','',descriptions[action]),el('div','asset-filename',media?`${media.name} · ${media.duration.toFixed(1)} 秒`:'尚未导入素材'),controls);return card;
  }));
}
function fillSettings(config){Object.entries(config).forEach(([key,value])=>{const field=$('#setting-'+key);if(!field)return;if(field.type==='checkbox')field.checked=value;else field.value=value;});updateSettingLabels();settingsLoaded=true;}
function updateSettingLabels(){$('#rate-label').textContent=$('#setting-rate').value+' 字/分钟';$('#volume-label').textContent=Math.round($('#setting-volume').value*100)+'%';$('#ollama-fields').classList.toggle('hidden',$('#setting-engine').value!=='ollama');}
$('#settings-form').addEventListener('input',updateSettingLabels);
$('#settings-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;const values={};new FormData(event.target).forEach((value,key)=>values[key]=value);['subtitles','auto_approve'].forEach(key=>values[key]=$('#setting-'+key).checked);values.rate=Number(values.rate);values.volume=Number(values.volume);const result=await attempt(()=>api('/api/settings',values));if(result)toast('设置已保存在这台 Mac');button.disabled=false;});
function render(data){latest=data;$('#connection').textContent='本机已连接';$('#connection-dot').classList.remove('error');$('#queue-count').textContent=data.queue.length;$('#pending-hint').textContent=data.config.auto_approve?'自动放行':'手动放行';$('#toggle-run').textContent=data.running?'Ⅱ 暂停排练':'▶ 开始排练';$('#run-dot').classList.toggle('active',data.running);$('#run-label').textContent=data.running?'排练进行中':'排练已暂停';$('#preview-state').textContent={idle:'待机中',thinking:'准备回答',action:'正在'+labels[data.state.action],speaking:'正在互动'}[data.state.phase];$('#description').title=data.config.engine==='rules'?'当前使用规则演示，非通用 AI 问答':'当前使用本地 Ollama';if(!settingsLoaded)fillSettings(data.config);renderQueue(data);renderHistory(data);renderAssets(data);}
const stream=new EventSource('/api/events');stream.onmessage=event=>{try{render(JSON.parse(event.data));}catch(error){console.error(error);toast('界面更新失败，请刷新',true);}};stream.onerror=()=>{$('#connection').textContent='本机连接中断，正在重连';$('#connection-dot').classList.add('error');};
addEventListener('pagehide',()=>stream.close());
