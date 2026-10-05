import { createHash } from "node:crypto";

/** Paired operator dashboard.
 * The service authenticates every API read; this module grants no authority. */
const script = String.raw`(() => {
'use strict';
const byId = id => document.getElementById(id);
const list = byId('tasks'), detail = byId('detail'), connection = byId('connection');
let csrf=null, authEpoch=0, credentialReady=false;
let externalSelected=null,externalTracked=null,externalView=null,externalEpoch=0,externalAfter=null,externalNext=null;
let externalPending=(()=>{try{const id=sessionStorage.getItem('dona.pending-external');return typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id)?id:null;}catch{return null;}})();
let pending=(()=>{try{return JSON.parse(sessionStorage.getItem("dona.pending-command")||"null");}catch{return null;}})();
let stream=null,streamBusy=false,deferredDetail=null;
let selected = null, selectedAttempt = null, selectedMain = null, capabilities = [], generation = 0, pageAfter = null, next = null, stopped = false, polling = false;
const labels = {interrupted:'中断',idle:'待機中',working:'実行中',starting:'起動中',stopped:'停止済み',error:'エラー',preparing:'実行準備中',dispatching:'起動処理中',blocked:'入力・承認待ち',needs_review:'確認が必要',cancelling:'取消処理中',inProgress:'進行中',declined:'拒否済み',active:'実行中',capacity_wait:'実行枠の空き待ち',rate_limit_wait:'利用上限の回復待ち',retry_exhausted:'再試行上限',running:'実行中',waiting:'待機中',queued:'実行待ち',paused:'一時停止',completed:'完了',failed:'失敗',cancelled:'取消済み',human_input:'質問への回答待ち',external_approval:'外部操作の承認・照合待ち',external_effect_unknown:'外部操作の実行結果を要確認（再実行保留）',rate_limit:'利用上限の回復待ち',retry_limit:'再試行上限',retry_wait:'再試行待ち',unknown:'状態未確認'};
const label = value => labels[value] || String(value || '未確認');
const node = (tag, text, className) => { const n = document.createElement(tag); if(text !== undefined) n.textContent = String(text); if(className) n.className = className; return n; };
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
function clearPrivate(message, auth) {
  generation++; authEpoch++; externalEpoch++; externalTracked=null;externalView=null; byId('external-panel').hidden=true;byId('external-items').replaceChildren();byId('external-detail').replaceChildren();byId('external-status').textContent='';byId('external-reconcile').hidden=true;credentialReady=false; if(auth){byId("objective").value="";byId("repository").value="";byId("base-ref").value="";} csrf=null; capabilities=[];stream=null;deferredDetail=null; byId("credential-panel").hidden=true; byId("submit-panel").hidden=true; byId("task-panel").hidden=true; byId("command-status").textContent=""; byId('main-conversations').replaceChildren(); byId('main-panel').hidden=true; list.replaceChildren(); detail.replaceChildren(node('p',message)); next = null; byId('next').disabled = true;
  connection.textContent = message; connection.dataset.state = 'disconnected';
  if(auth) { stopped = true; byId('pairing').hidden = false;byId('logout').hidden=true; }
}
async function read(url) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try { const response = await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{accept:'application/json'}});
    if(response.status===401 || response.status===403) throw Object.assign(Error(),{auth:true});
    if(!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw Error();
    return await response.json();
  } finally { clearTimeout(timer); }
}
function renderDetail(value) {
  const task = value?.snapshot?.task;
  if(!task || task.task_id!==selected || (selectedAttempt && value.snapshot.selected_attempt_id!==selectedAttempt) || !Array.isArray(value.snapshot.attempts)) throw Error();
  if(document.activeElement?.closest('[data-question-form]')){deferredDetail=value;return;}
  deferredDetail=null;
  const content = document.createDocumentFragment();
  content.append(node('h2',task.task_key || task.task_id),node('p',task.task_id,'muted'),node('p','Task: '+label(task.state)+(task.wait_reason?' · '+label(task.wait_reason):''),'state'));
  if(typeof value.snapshot.request==='string'&&value.snapshot.request)content.append(node('h3','依頼内容'),node('pre',value.snapshot.request));
  content.append(node('p','ワーカー: '+label(task.worker_status)+' · 更新 '+displayTime(task.updated_at),'muted'));
  if(task.local_operator_owned===true && capabilities.includes('tasks:cancel') && task.desired_state==='running' && !['completed','failed','cancelled'].includes(task.state)) {
    const button=node('button','このTaskを取り消す');button.type='button';button.disabled=!!pending;
    button.addEventListener('click',()=>{if(!confirm('このTaskの実行を取り消しますか？ 停止確認が完了するまで取消処理中になります。'))return;void command('/api/tasks/'+encodeURIComponent(task.task_id)+'/cancel','cancel',{attempt_id:task.current_attempt_id,revision:task.revision},button);});content.append(button);
  }
  const questions=node('section');questions.dataset.questions=task.task_id;content.append(questions);
  if(task.local_operator_owned===true && capabilities.includes('tasks:submit') && task.desired_state==='running')void loadQuestions(task.task_id,questions);
  if(capabilities.includes('approvals:native') && task.desired_state==='running') {const approvals=node('section');content.append(approvals);void loadNativeApprovals(task.task_id,approvals);}
  content.append(node('h3','実行履歴'));
  const attempts = node('ol');
  for(const attempt of value.snapshot.attempts) {
    const item=node('li'),button=node('button','Attempt '+attempt.number+' · '+label(attempt.status)+(attempt.outcome?' · '+label(attempt.outcome):''));button.type='button';button.dataset.attempt=attempt.attempt_id;
    button.setAttribute('aria-pressed',String(attempt.attempt_id===(selectedAttempt || value.snapshot.selected_attempt_id || task.current_attempt_id)));
    button.disabled=!validId(attempt.attempt_id);
    button.addEventListener('click',()=>{selectedAttempt=attempt.attempt_id;rememberSelection();generation++;detail.replaceChildren(node('p','実行履歴を取得しています…'));void detailRead();});item.append(button);attempts.append(item);
  }
  content.append(attempts,node('h3','ワーカーの会話'));
  if(task.next_check_at)content.append(node('p','次の確認予定: '+displayTime(task.next_check_at),'muted'));
  if(value.snapshot.result) {
    const result=value.snapshot.result;content.append(node('h3','実行結果'),node('p',displayTime(result.completed_at),'muted'),node('pre',result.summary));
    if(result.output)content.append(node('pre',result.output));
    for(const artifact of result.artifacts || [])content.append(node('p',artifact.display_name+' · '+artifact.kind));
  }
  appendConversation(content,value.runtime);
  const focus=document.activeElement?.dataset?.attempt;detail.replaceChildren(content);if(focus)Array.from(detail.querySelectorAll('button')).find(b=>b.dataset.attempt===focus)?.focus({preventScroll:true});
}
const displayTime = value => {const time=new Date(value);return Number.isFinite(time.getTime())?new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'medium'}).format(time):String(value||'時刻未確認');};
function selectionState() {
  for(const button of list.querySelectorAll('[data-task]'))button.setAttribute('aria-pressed',String(!selectedMain&&button.dataset.task===selected));
  for(const button of byId('main-conversations').querySelectorAll('[data-main]'))button.setAttribute('aria-pressed',String(!!selectedMain&&button.dataset.main===selectedMain.name+':'+selectedMain.generation));
}
function emptyDetail() {
  if(selected||selectedMain)return;
  detail.replaceChildren(node('h2','会話を選んでください'),node('p',capabilities.includes('conversations:main:read')&&capabilities.includes('tasks:read')?'左のDona本体またはTaskを選ぶと、状態・実行履歴・会話を確認できます。':capabilities.includes('conversations:main:read')?'Dona本体を選ぶと、現在の状態と会話を確認できます。':capabilities.includes('tasks:read')?'Taskを選ぶと、状態・実行履歴・ワーカーの会話を確認できます。':'この端末に許可された操作を利用できます。'));
}
function appendConversation(content,runtime) {
  if(runtime?.status==='observed') {
    const c = runtime.conversation;
    if(!Array.isArray(c.items)) throw Error();
    content.append(node('p','状態: '+label(c.state)+' · '+(c.connected?'Runtime接続中':'Runtime接続なし')+' · 観測 '+displayTime(c.observed_at),'muted'));
    if(c.gap || c.truncated) content.append(node('p','履歴の一部は保持期間または表示上限のため省略されています。','notice'));
    const visible=c.items.filter(item=>['user_message','assistant_message','tool_progress'].includes(item.kind));
    if(visible.length===0) content.append(node('p',c.connected?'この会話には表示できる発言やツール実行がまだありません。更新を待つか、別の会話を選んでください。':'この世代には表示できる保存済みの発言やツール実行がありません。','muted'));
    const observedTimes=new Map();
    for(const event of (Array.isArray(c.events)?c.events:[]).slice(-1000)) {
      if(!['item/started','item/completed'].includes(event.kind)||typeof event.item_id!=='string'||typeof event.turn_id!=='string'||typeof event.observed_at!=='string'||!Number.isFinite(Date.parse(event.observed_at)))continue;
      const key=JSON.stringify([event.turn_id,event.item_id]),times=observedTimes.get(key)||{};
      const field=event.kind==='item/started'?'started':'completed';
      if(!times[field]||(field==='started'?Date.parse(event.observed_at)<Date.parse(times[field]):Date.parse(event.observed_at)>Date.parse(times[field])))times[field]=event.observed_at;
      observedTimes.set(key,times);
    }
    const messages = node('div',undefined,'messages');
    const open=new Set(Array.from(detail.querySelectorAll('details[open][data-item-detail]')).map(n=>n.dataset.itemDetail));
    const toolLabels={commandExecution:'コマンド実行',fileChange:'ファイル変更',mcpToolCall:'MCPツール',dynamicToolCall:'ツール実行',webSearch:'Web検索',imageView:'画像の確認'};
    for(const item of visible) {
      const entry = node('article');entry.dataset.item=item.id;
      entry.append(node('h4',item.kind==='assistant_message'?'Codex':item.kind==='user_message'?'ユーザー・依頼入力':item.tool_name||toolLabels[item.tool_type]||'ツールの進捗'));
      const fold=(title,text,field)=>{if(typeof text!=='string'||!text)return;const key=[c.name,c.generation,item.id,field].join(':');const box=node('details');box.dataset.itemDetail=key;box.open=open.has(key);box.append(node('summary',title),node('pre',text));entry.append(box);};
      if(item.status) entry.append(node('p',label(item.status),'state'));
      const times=observedTimes.get(JSON.stringify([item.turn_id,item.id]));
      if(times?.started)entry.append(node('p','開始を観測: '+displayTime(times.started),'muted'));
      if(times?.completed)entry.append(node('p','完了を観測: '+displayTime(times.completed),'muted'));
      if(item.text) entry.append(node('pre',item.text));
      if(item.command) entry.append(node('h5','コマンド'),node('pre',item.command,'command'));
      const facts=[];if(Number.isFinite(item.exit_code))facts.push('終了コード '+item.exit_code);if(Number.isFinite(item.duration_ms))facts.push('所要時間 '+(item.duration_ms/1000).toLocaleString('ja-JP',{maximumFractionDigits:2})+' 秒');
      if(facts.length)entry.append(node('p',facts.join(' · '),'muted'));
      if(item.error)entry.append(node('h5','エラー'),node('pre',item.error,'notice'));
      if(Array.isArray(item.files)&&item.files.length){const files=node('ul');for(const file of item.files){const counts=[];if(Number.isFinite(file.additions))counts.push('+'+file.additions);if(Number.isFinite(file.deletions))counts.push('−'+file.deletions);files.append(node('li',({add:'追加',delete:'削除',update:'更新'})[file.change]+' · '+file.path+(counts.length?' ('+counts.join(' / ')+')':'')));}entry.append(node('h5','変更ファイル'),files);}
      fold('入力を表示',item.input,'input');
      fold('実行結果を表示',item.output,'output');
      if(item.truncated)entry.append(node('p','この項目の内容は表示上限のため一部省略されています。','notice'));
      if(item.kind==='tool_progress'&&!item.text&&!item.command&&!item.input&&!item.output&&!item.error&&!item.files?.length)entry.append(node('p','この履歴には実行内容・結果の詳細が記録されていません。','muted'));
      messages.append(entry);
    }
    content.append(messages);
  } else content.append(node('p',({unavailable:'会話を現在取得できません。Taskの状態とは別の接続状態です。',not_started:'会話はまだ開始されていません。',forbidden:'この接続では会話の閲覧が許可されていません。'})[runtime?.status] || '会話の状態を確認できません。','notice'));
}
async function detailRead() {
  if(!selected || stopped) return;
  const id=selected, token=++generation;
  try { const value=await read('/api/tasks/'+encodeURIComponent(id)+(selectedAttempt?'?attempt='+encodeURIComponent(selectedAttempt):'')); if(token!==generation || id!==selected || stopped)return; renderDetail(value);rememberStream(value,taskPath()); }
  catch(error) { if(token!==generation || id!==selected || stopped)return; clearPrivate(error.auth?'接続の認証が必要です。':'接続が切れています。表示を消去しました。',error.auth); }
}
function renderList(value) {
  if(!Array.isArray(value?.items) || (value.next!==null && !validId(value.next))) throw Error();
  const focused=document.activeElement?.dataset?.task;
  const content=document.createDocumentFragment();
  for(const task of value.items) {
    if(!validId(task.task_id)) throw Error();
    const button=node('button',(task.task_key || task.task_id)+' · '+label(task.state)); button.type='button'; button.dataset.task=task.task_id;button.setAttribute('aria-label',(task.task_key || task.task_id)+' · '+label(task.state));if(task.updated_at)button.append(node('span','更新 '+displayTime(task.updated_at),'list-time'));
    button.setAttribute('aria-pressed',String(task.task_id===selected));
    button.addEventListener('click',()=> {selected=task.task_id; selectedAttempt=null;selectedMain=null;rememberSelection(); generation++; detail.replaceChildren(node('p','会話を取得しています…'));
      selectionState(); void detailRead(); });
    content.append(button);
  }
  if(value.items.length===0)content.append(node('p','表示できるTaskはありません。','muted'));
  list.replaceChildren(content); if(focused) Array.from(list.querySelectorAll('button')).find(b=>b.dataset.task===focused)?.focus({preventScroll:true});
  next=value.next; byId('next').disabled=next===null;
}
async function refresh() {
  if(polling || stopped)return; polling=true; const token=generation;
  try {const session=await read('/api/session');if(token!==generation || stopped)return;capabilities=Array.isArray(session.capabilities)?session.capabilities:[];csrf=typeof session.csrf==='string'?session.csrf:null;
    if(selected&&!capabilities.includes('tasks:read')){selected=null;selectedAttempt=null;rememberSelection();}
    if(selectedMain&&!capabilities.includes('conversations:main:read')){selectedMain=null;rememberSelection();}
    byId('submit-panel').hidden=!capabilities.includes('tasks:submit');byId('task-panel').hidden=!capabilities.includes('tasks:read');byId('control-hint').hidden=capabilities.includes('tasks:read')||!capabilities.includes('tasks:cancel');
    byId('task-layout').hidden=!capabilities.includes('tasks:read')&&!capabilities.includes('conversations:main:read');byId('submit-task').disabled=!!pending;showPending();await credentialStatus();await mainList();await externalRefresh();
    if(capabilities.includes('tasks:read')) {const value=await read('/api/tasks'+(pageAfter?'?after='+encodeURIComponent(pageAfter):''));if(token!==generation || stopped)return;renderList(value);}
    if(token!==generation || stopped)return; connection.textContent='接続中 · 5秒ごとに更新';connection.dataset.state='connected';emptyDetail();selectionState();
    if(stream)await streamRead();else if(selectedMain)await mainRead();else if(capabilities.includes('tasks:read'))await detailRead();
  } catch(error) {if(token===generation && !stopped)clearPrivate(error.auth?'接続の認証が必要です。':'接続が切れています。表示を消去しました。',error.auth);}
  finally {polling=false;}
}
async function mainList() {
  const allowed=capabilities.includes('conversations:main:read');byId('main-panel').hidden=!allowed;
  if(!allowed){byId('main-conversations').replaceChildren();return;}
  const token=generation,value=await read('/api/conversations/main');if(token!==generation||stopped)return;
  const box=document.createDocumentFragment();
  for(const entry of value.items || []) {
    if(typeof entry.name!=='string'||typeof entry.generation!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(entry.name)||!/^[A-Za-z0-9_-]{1,160}$/.test(entry.generation))throw Error();
    const button=node('button',entry.name+' · '+label(entry.state)+(entry.connected?' · 接続中':' · 保存された履歴'));if(entry.observed_at)button.append(node('span','観測 '+displayTime(entry.observed_at),'list-time'));button.append(node('span',entry.generation,'list-time'));button.type='button';button.dataset.main=entry.name+':'+entry.generation;
    button.addEventListener('click',()=>{selectedMain={name:entry.name,generation:entry.generation};selected=null;selectedAttempt=null;rememberSelection();generation++;detail.replaceChildren(node('p','Dona本体の会話を取得しています…'));selectionState();void mainRead();});box.append(button);
  }
  const focused=document.activeElement?.dataset?.main;if(!box.childNodes.length)box.append(node('p','表示できるDona本体の会話はありません。','muted'));byId('main-conversations').replaceChildren(box);selectionState();
  if(focused)Array.from(byId('main-conversations').querySelectorAll('button')).find(b=>b.dataset.main===focused)?.focus({preventScroll:true});
}
async function mainRead() {
  if(!selectedMain||stopped)return;const target=selectedMain,token=++generation;
  try {const value=await read('/api/conversations/main/'+encodeURIComponent(target.name)+'/'+encodeURIComponent(target.generation));if(token!==generation||selectedMain!==target||stopped)return;
    const content=document.createDocumentFragment();content.append(node('h2','Dona本体の会話'),node('p','このDona全体にまたがる発言です。特定のTaskの会話ではありません。','notice'));appendConversation(content,value);detail.replaceChildren(content);rememberStream(value,mainPath());
  }catch(error){if(token===generation&&!stopped)clearPrivate(error.auth?'接続の認証が必要です。':'接続が切れています。表示を消去しました。',error.auth);}
}
function taskPath() {return '/api/tasks/'+encodeURIComponent(selected)+(selectedAttempt?'?attempt='+encodeURIComponent(selectedAttempt):'');}
function mainPath() {return '/api/conversations/main/'+encodeURIComponent(selectedMain.name)+'/'+encodeURIComponent(selectedMain.generation);}
function rememberStream(value,path) {stream=typeof value.stream_cursor==='string'?{cursor:value.stream_cursor,path}:null;}
function rememberSelection() {
  stream=null;deferredDetail=null;const query=new URLSearchParams();if(selected){query.set('task',selected);if(selectedAttempt)query.set('attempt',selectedAttempt);}else if(selectedMain){query.set('main',selectedMain.name);query.set('generation',selectedMain.generation);}
  const hash=query.toString();if(location.hash.slice(1)!==hash)history.pushState(null,'',location.pathname+location.search+(hash?'#'+hash:''));
}
function restoreSelection() {
  stream=null;deferredDetail=null;generation++;selected=null;selectedAttempt=null;selectedMain=null;
  const query=new URLSearchParams(location.hash.slice(1)),keys=[...query.keys()],id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
  if(keys.length<=2&&keys.every(k=>['task','attempt'].includes(k))&&validId(query.get('task'))&&(!query.has('attempt')||validId(query.get('attempt')))){selected=query.get('task');selectedAttempt=query.get('attempt');}
  else if(keys.length===2&&keys.includes('main')&&keys.includes('generation')&&id(query.get('main'))&&id(query.get('generation')))selectedMain={name:query.get('main'),generation:query.get('generation')};
  detail.replaceChildren(node('p','会話を選択してください。'));
  if(!stopped){if(selectedMain&&capabilities.includes('conversations:main:read'))void mainRead();else if(selected&&capabilities.includes('tasks:read'))void detailRead();}
}
async function streamRead() {
  if(!stream||streamBusy||stopped)return;const current=stream,token=generation,epoch=authEpoch;streamBusy=true;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const url=new URL(current.path,location.origin);url.pathname+='/events';
    const response=await fetch(url.pathname+url.search,{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal,headers:{accept:'text/event-stream','last-event-id':current.cursor}});
    if(response.status===401||response.status===403)throw Object.assign(Error(),{auth:true});
    if(!response.ok||!response.headers.get('content-type')?.includes('text/event-stream'))throw Error();
    const reader=response.body.getReader(),decoder=new TextDecoder();let raw='',bytes=0;
    for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4096){await reader.cancel();throw Error();}raw+=decoder.decode(part.value,{stream:true});}
    if(epoch!==authEpoch||token!==generation||stream!==current||stopped)return;
    const events=raw.match(/^event: (snapshot|heartbeat|reset)$/gm),ids=raw.match(/^id: ([-A-Za-z0-9_.]+)$/gm);
    if(events?.length!==1||ids?.length!==1||!raw.endsWith('\n\n'))throw Error();
    current.cursor=ids[0].slice(4);
    if(events[0]!=='event: heartbeat'){
      stream=null;if(selectedMain)await mainRead();else await detailRead();
      if(events[0]==='event: reset'&&epoch===authEpoch&&!stopped){connection.textContent='履歴の連続性を再確認しました。最新の状態を取得しました。';}
    }
  }catch(error){if(epoch===authEpoch&&token===generation&&stream===current&&!stopped)clearPrivate(error.auth?'接続の認証が必要です。':'更新の接続が切れました。最新状態から再接続します。',error.auth);}
  finally{clearTimeout(timer);streamBusy=false;}
}
detail.addEventListener('focusout',()=>setTimeout(()=>{const value=deferredDetail;if(value&&!stopped&&!document.activeElement?.closest('[data-question-form]')){deferredDetail=null;renderDetail(value);}},0));
window.addEventListener('popstate',restoreSelection);
restoreSelection();
const fromBase64=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const toBase64=value=>btoa(String.fromCharCode(...new Uint8Array(value))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
async function credentialStatus() {
  const allowed=capabilities.includes('approvals:native')||capabilities.includes('approvals:external');byId('credential-panel').hidden=!allowed;if(!allowed)return;
  const epoch=authEpoch;
  try {const state=await read('/api/credential');if(epoch!==authEpoch)return;credentialReady=state.registered===true;byId('credential-status').textContent=state.registered?'この端末の承認用パスキーは登録済みです。':state.can_enroll?'承認操作には、この端末のパスキー登録が必要です。':'登録可能な時間を過ぎました。Macで新しい接続コードを発行してください。';byId('credential-register').hidden=state.registered||!state.can_enroll;}
  catch {if(epoch===authEpoch){credentialReady=false;byId('credential-status').textContent='パスキー登録状態を確認できません。';byId('credential-register').hidden=true;}}
}
async function credentialPost(url,body) {
  if(!csrf)throw Error();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch(url,{method:'POST',credentials:'same-origin',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});const value=await response.json();if(!response.ok&&!(response.status===409&&value?.rejection?.not_committed===true))throw Error();return value;}finally{clearTimeout(timer);}
}
byId('credential-register').addEventListener('click',async()=>{const button=byId('credential-register'),epoch=authEpoch;button.disabled=true;
  try {const ceremony=await credentialPost('/api/credential/options',{});if(epoch!==authEpoch)return;const json=ceremony.options;
    const publicKey=typeof PublicKeyCredential.parseCreationOptionsFromJSON==='function'?PublicKeyCredential.parseCreationOptionsFromJSON(json):{...json,challenge:fromBase64(json.challenge),user:{...json.user,id:fromBase64(json.user.id)},excludeCredentials:(json.excludeCredentials||[]).map(c=>({...c,id:fromBase64(c.id)}))};
    const credential=await navigator.credentials.create({publicKey});if(epoch!==authEpoch||!credential)return;
    const response=typeof credential.toJSON==='function'?credential.toJSON():{id:credential.id,rawId:toBase64(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),authenticatorAttachment:credential.authenticatorAttachment,response:{clientDataJSON:toBase64(credential.response.clientDataJSON),attestationObject:toBase64(credential.response.attestationObject),transports:credential.response.getTransports?.()||[]}};
    await credentialPost('/api/credential/register',{ceremony_id:ceremony.ceremony_id,response});if(epoch===authEpoch)await credentialStatus();
  }catch{if(epoch===authEpoch){byId('credential-status').textContent='登録結果を確認できません。状態を再確認してください。自動で再送しません。';}}
  finally{button.disabled=false;}
});
function savePending(value) {pending=value;try{if(value)sessionStorage.setItem('dona.pending-command',JSON.stringify(value));else sessionStorage.removeItem('dona.pending-command');}catch{}showPending();}
function showPending() {byId('reconcile').hidden=!pending;byId('submit-task').disabled=!!pending;if(pending)byId('command-status').textContent='受付を照合する操作があります。自動で再送しません。受付ID: '+pending.request_id;}
function rejected(value,requestId,operation) {
  const r=value?.rejection;return r?.not_committed===true&&r.request_id===requestId&&r.operation===operation&&['invalid','conflict','unavailable'].includes(r.code);
}
function accepted(value) {
  if(pending&&rejected(value,pending.request_id,pending.operation)){savePending(null);byId('command-status').textContent='この操作は受け付けられませんでした。最新の内容を確認して、改めて操作してください。';if(selected)void detailRead();return;}
  if(!value?.receipt || !pending || value.receipt.request_id!==pending.request_id || value.receipt.operation!==pending.operation)throw Error();
  const receipt=value.receipt;savePending(null);byId('command-status').textContent=(receipt.operation==='cancel'?'取消を受け付けました。停止完了はTaskの状態で確認してください。':receipt.operation==='question_reply'?'回答を受け付けました。Donaがワーカーへ届けます。':receipt.operation==='native_approval'?'承認判断を受け付けました。ワーカーへの反映はTaskの状態で確認してください。':'依頼を受け付けました。')+' Task: '+receipt.task_id;
  if(capabilities.includes('tasks:read')){selected=receipt.task_id;selectedAttempt=null;selectedMain=null;rememberSelection();void detailRead();}
}
async function reconcile() {
  if(!pending)return;const expected=pending,epoch=authEpoch;byId('reconcile').disabled=true;
  try {const value=await read('/api/commands/'+encodeURIComponent(expected.request_id)+'?operation='+encodeURIComponent(expected.operation));if(epoch!==authEpoch||pending!==expected)return;
    if(value.receipt)accepted(value);else byId('command-status').textContent='受付記録はまだ確認できません。自動再送せず、このIDの照合を続けてください: '+expected.request_id;
  }catch(error){if(epoch!==authEpoch)return;if(error.auth)clearPrivate('この操作の照合権限がありません。Macで接続を確認してください。',true);else byId('command-status').textContent='受付を照合できません。再送せず、接続回復後に受付状況を確認してください。';}
  finally{byId('reconcile').disabled=false;}
}
async function command(url,operation,input,button) {
  if(pending||!csrf)return;const epoch=authEpoch,request_id=crypto.randomUUID();savePending({request_id,operation});button.disabled=true;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try {const response=await fetch(url,{method:'POST',credentials:'same-origin',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({...input,request_id})});
    if(epoch!==authEpoch)return;if(response.status===401||response.status===403){clearPrivate('操作の権限を確認できません。受付IDを保存しています。',true);return;}
    const value=await response.json();if(!response.ok&&!(response.status===409&&rejected(value,request_id,operation)))throw Error();accepted(value);
  }catch {if(epoch===authEpoch)await reconcile();}finally{clearTimeout(timer);button.disabled=!!pending;}
}
async function loadQuestions(taskId,target) {
  const epoch=authEpoch;
  try {const value=await read('/api/tasks/'+encodeURIComponent(taskId)+'/questions?kind=question');if(epoch!==authEpoch||selected!==taskId||!target.isConnected)return;
    if(value.task_id!==taskId||!validId(value.current_attempt_id)||!Number.isSafeInteger(value.revision))throw Error();
    for(const q of value.questions||[]) {
      if(q.kind!=='question'||q.state!=='pending'||!validId(q.question_id)||!Array.isArray(q.request?.questions))continue;
      const form=node('form');form.dataset.questionForm=q.question_id;form.append(node('h3','ワーカーからの質問'));const fields=[];
      for(const question of q.request.questions) {
        if(typeof question.id!=='string'||typeof question.question!=='string')continue;
        const group=node('fieldset');group.append(node('legend',question.header||'確認'),node('p',question.question));let field;
        if(Array.isArray(question.options)&&question.options.length){field=node('select');field.required=true;const empty=node('option','回答を選択してください');empty.value='';field.append(empty);for(const option of question.options){const item=node('option',option.label+(option.description?' — '+option.description:''));item.value=option.label;field.append(item);}}
        else {field=node('textarea');field.required=true;field.maxLength=10000;}
        field.setAttribute('aria-label',question.question);group.append(field);form.append(group);fields.push({id:question.id,field});
      }
      if(!fields.length)continue;const button=node('button','回答をDonaに送る');button.type='submit';button.disabled=!!pending;form.append(button);
      form.addEventListener('submit',event=>{event.preventDefault();const answers={};for(const entry of fields)answers[entry.id]={answers:[entry.field.value]};void command('/api/tasks/'+encodeURIComponent(taskId)+'/questions/'+encodeURIComponent(q.question_id)+'/reply','question_reply',{attempt_id:value.current_attempt_id,revision:value.revision,kind:'question',answers},button);});target.append(form);
    }
  }catch(error){if(epoch===authEpoch&&target.isConnected){if(error.auth)target.replaceChildren(node('p','このTaskの質問を取得する権限がありません。'));else target.replaceChildren(node('p','質問を取得できません。次の更新で再確認します。'));}}
}
async function loadNativeApprovals(taskId,target) {
  const epoch=authEpoch;
  try {const value=await read('/api/tasks/'+encodeURIComponent(taskId)+'/questions?kind=approval');if(epoch!==authEpoch||selected!==taskId||!target.isConnected)return;
    if(value.task_id!==taskId||!validId(value.current_attempt_id)||!Number.isSafeInteger(value.revision)||!Array.isArray(value.questions)||value.questions.length>100)throw Error();
    for(const q of value.questions) {
      if(q.kind!=='approval'||q.state!=='pending'||!validId(q.question_id)||!q.request||typeof q.request!=='object')continue;
      const panel=node('section');panel.append(node('h3','ワーカーの実行承認'),node('p','現在のAttempt: '+value.current_attempt_id,'muted'));
      const request=q.request,known=['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(request.method);
      const visible=Object.fromEntries(Object.entries(request).filter(([key])=>!['threadId','turnId','itemId'].includes(key)));
      const literal=JSON.stringify(visible,null,2),complete=typeof literal==='string'&&new TextEncoder().encode(literal).length<=65536;
      panel.append(node('pre',complete?literal:'要求が表示上限を超えています。Mac側で確認してください。'));
      if(request.method==='item/fileChange/requestApproval'&&!request.changes&&!request.diff)panel.append(node('p','この要求には変更内容の差分が含まれていません。提示された変更許可の範囲を確認してください。','notice'));
      if(!known)panel.append(node('p','未対応の承認形式です。Mac側で確認してください。','notice'));
      if(!credentialReady)panel.append(node('p','判断を送る前に、この端末の承認用パスキーを登録してください。','notice'));
      const buttons=node('div',undefined,'controls');
      for(const [accepted,label] of [[true,'この要求を許可'],[false,'この要求を拒否']]) {
        const button=node('button',label);button.type='button';button.disabled=!!pending||!complete||!known||!credentialReady;
        button.addEventListener('click',()=>void nativeApproval({task_id:taskId,attempt_id:value.current_attempt_id,revision:value.revision,question_id:q.question_id,kind:'approval',accepted},buttons));buttons.append(button);
      }
      panel.append(buttons);target.append(panel);
    }
  }catch(error){if(epoch===authEpoch&&target.isConnected)target.replaceChildren(node('p',error.auth?'このTaskの承認要求を取得する権限がありません。':'承認要求を取得できません。次の更新で再確認します。'));}
}
async function nativeApproval(input,buttons) {
  if(pending||!csrf||!credentialReady||!capabilities.includes('approvals:native'))return;
  const epoch=authEpoch,taskId=selected,attempt=selectedAttempt,request_id=crypto.randomUUID();savePending({request_id,operation:'native_approval'});
  for(const button of buttons.querySelectorAll('button'))button.disabled=true;
  let decideStarted=false;
  try {
    const ceremony=await credentialPost('/api/native/options',{input:{...input,request_id}});
    if(epoch!==authEpoch||selected!==taskId||selectedAttempt!==attempt)return;
    const json=ceremony.options,publicKey=typeof PublicKeyCredential.parseRequestOptionsFromJSON==='function'?PublicKeyCredential.parseRequestOptionsFromJSON(json):{...json,challenge:fromBase64(json.challenge),allowCredentials:(json.allowCredentials||[]).map(c=>({...c,id:fromBase64(c.id)}))};
    const credential=await navigator.credentials.get({publicKey});
    if(epoch!==authEpoch||selected!==taskId||selectedAttempt!==attempt||!credential)return;
    const response=typeof credential.toJSON==='function'?credential.toJSON():{id:credential.id,rawId:toBase64(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),authenticatorAttachment:credential.authenticatorAttachment,response:{clientDataJSON:toBase64(credential.response.clientDataJSON),authenticatorData:toBase64(credential.response.authenticatorData),signature:toBase64(credential.response.signature),userHandle:credential.response.userHandle?toBase64(credential.response.userHandle):null}};
    decideStarted=true;const value=await credentialPost('/api/native/decide',{ceremony_id:ceremony.ceremony_id,response});if(epoch===authEpoch)accepted(value);
  }catch(error){
    if(epoch!==authEpoch)return;
    if(!decideStarted)byId('command-status').textContent='承認操作が中断されたため、判断は送信していません。';
    else await reconcile();
  }finally{
    if(!decideStarted&&pending?.request_id===request_id){savePending(null);if(epoch===authEpoch&&!stopped)void detailRead();}
    for(const button of buttons.querySelectorAll('button'))button.disabled=!!pending;
  }
}
function externalSavePending(id) {externalPending=id;try{if(id)sessionStorage.setItem('dona.pending-external',id);else sessionStorage.removeItem('dona.pending-external');}catch{}byId('external-reconcile').hidden=!id;}
const externalState=value=>({requested:'承認要求を受付済み',delivery_pending:'承認内容の提示待ち',delivery_unknown:'承認内容の提示結果未確認',sent:'承認内容を提示済み',delivery_failed:'承認内容の提示失敗',execution_cancelled:'実行取消済み',consume_expired:'実行受付期限切れ',needs_review:'要確認',claimed:'実行準備中',acceptance_unknown:'送信結果未確認',pending:'判断待ち',awaiting_decision:'判断待ち',draft:'確認準備中',decided:'判断受付済み',authorized:'許可済み',consumed:'判断受付済み',approved:'許可済み',rejected:'拒否済み',expired:'期限切れ',cancelled:'取消済み',ready:'実行待ち',queued:'実行待ち',running:'実行中',executing:'実行中',succeeded:'実行成功',completed:'完了',failed:'失敗',unknown:'結果未確認',execution_unknown:'実行結果未確認'})[value]||'状態未確認';
async function externalRefresh() {
  const allowed=capabilities.includes('approvals:external');byId('external-panel').hidden=!allowed;
  if(!allowed){externalView=null;byId('external-items').replaceChildren();byId('external-detail').replaceChildren();return;}
  const epoch=authEpoch,selection=externalEpoch,value=await read('/api/approvals'+(externalAfter?'?after='+encodeURIComponent(externalAfter):''));
  if(epoch!==authEpoch||selection!==externalEpoch)return;
  if(value.available===false){externalView=null;byId('external-items').replaceChildren(node('p','外部操作承認の準備が必要です。Mac側の設定を確認してください。'));byId('external-detail').replaceChildren();byId('external-next').disabled=true;byId('external-status').textContent='';return;}
  if(value.available!==true||!Array.isArray(value.items)||value.items.length>100||(value.next!==null&&!validId(value.next)))throw Error();
  const box=document.createDocumentFragment(),focused=document.activeElement?.dataset?.external;
  for(const item of value.items){if(!validId(item.request_id)||item.operation!=='slack.post_thread_reply.v1')continue;
    const button=node('button','Slackスレッドへの返信 · '+externalState(item.state));button.type='button';button.dataset.external=item.request_id;
    button.addEventListener('click',()=>{externalSelected=item.request_id;externalView=null;externalEpoch++;byId('external-detail').replaceChildren(node('p','承認内容を取得しています…'));void externalSelect();});box.append(button);
  }
  if(!box.childNodes.length)box.append(node('p','外部操作の承認要求はありません。'));byId('external-items').replaceChildren(box);
  if(focused)Array.from(byId('external-items').querySelectorAll('button')).find(b=>b.dataset.external===focused)?.focus({preventScroll:true});
  externalNext=value.next;byId('external-next').disabled=!externalNext;byId('external-reconcile').hidden=!externalPending;
  if(externalSelected){if(externalTracked===externalSelected||externalPending===externalSelected)await externalStatus(externalSelected);else await externalSelect(false);}
}
async function externalSelect(render=true) {
  const id=externalSelected,epoch=authEpoch,selection=externalEpoch;
  const value=await externalStatus(id);if(!value||epoch!==authEpoch||selection!==externalEpoch||id!==externalSelected)return;
  const state=value.request_state??value.state,decision=typeof value.decision==='string'?value.decision:value.decision?.kind;
  if(decision||!['requested','delivery_pending','delivery_unknown','sent'].includes(state)||!Number.isFinite(Date.parse(value.expires_at))||Date.parse(value.expires_at)<=Date.now()||externalPending===id){
    externalTracked=id;externalView=null;byId('external-detail').replaceChildren(node('h3','外部操作の履歴'),node('p','判断と実行の状態を表示しています。この画面から再送は行いません。'));return;
  }
  externalTracked=null;const failure=await externalRead(render);
  if(failure==='unavailable'&&epoch===authEpoch&&selection===externalEpoch&&id===externalSelected&&!externalView)renderExternalStatus(value,id);
}
function localExpiry(value) {const date=new Date(value);if(!Number.isFinite(date.getTime()))return '日時未確認';try{return new Intl.DateTimeFormat(undefined,{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'long'}).format(date);}catch{return '日時を表示できません';}}
function targetName(name,id) {return typeof name==='string'&&name.length>0&&name.length<=256?name+'（'+id+'）':id;}
function validPresentation(value,id) {
  return value&&value.request_id===id&&value.operation==='slack.post_thread_reply.v1'&&typeof value.exact_draft==='string'&&new TextEncoder().encode(value.exact_draft).length<=65536
    &&['workspace_id','channel_id','thread_ts','expires_at','presentation_digest'].every(key=>typeof value[key]==='string'&&value[key].length<=256)
    &&['slack','local_operator'].includes(value.requester?.kind)&&typeof value.requester.label==='string'&&value.requester.label.length>0&&value.requester.label.length<=256
    &&value.risk==='external_message'&&typeof value.operation_summary==='string'&&value.operation_summary.length>0&&value.operation_summary.length<=256
    &&typeof value.display_fingerprint==='string'&&/^[A-F0-9]{16}$/.test(value.display_fingerprint)&&typeof value.created_at==='string'&&Number.isFinite(Date.parse(value.created_at))
    &&Number.isSafeInteger(value.request_revision)&&Number.isSafeInteger(value.presentation_revision)&&Array.isArray(value.notified_user_ids)&&value.notified_user_ids.length<=100
    &&value.notified_user_ids.every(id=>typeof id==='string'&&id.length<=128)&&Number.isFinite(Date.parse(value.expires_at));
}
const samePresentation=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function disableExternal(message) {externalView=null;for(const button of byId('external-detail').querySelectorAll('button'))button.disabled=true;byId('external-status').textContent=message;}
async function externalRead(render) {
  const id=externalSelected,epoch=authEpoch,selection=externalEpoch;if(!id)return;
  try{const value=await read('/api/approvals/'+encodeURIComponent(id));if(epoch!==authEpoch||selection!==externalEpoch||id!==externalSelected)return;
    if(!validPresentation(value,id))throw Error();
    if(!render){if(!externalView||!samePresentation(externalView,value))disableExternal('表示後に承認内容またはrevisionが変わりました。一覧から選び直して確認してください。');else if(Date.parse(value.expires_at)<=Date.now())disableExternal('この承認要求は期限切れです。');return;}
    externalView=value;const box=document.createDocumentFragment();box.append(node('h3','Donaの外部操作: Slackスレッドへの返信'),node('p','承認すると以下の内容を指定先へ送信できます。許可と送信成功は別の状態です。','notice'));
    box.append(node('p','依頼元: '+(value.requester?.label||'未確認')),node('p','操作: '+(value.operation_summary||'Slackスレッドへの返信')),node('p','リスク: '+(value.risk==='external_message'?'Slackへ外部メッセージを送信':'未確認')),node('p','照合番号: '+(value.display_fingerprint||'未確認')),node('p','作成日時: '+localExpiry(value.created_at)));
    box.append(node('p','ワークスペース: '+targetName(value.workspace_name,value.workspace_id)),node('p','チャンネル: '+targetName(value.channel_name,value.channel_id)),node('p','スレッド: '+value.thread_ts),node('p','通知するユーザー: '+(value.notified_user_ids.join(', ')||'なし')),node('p','有効期限: '+localExpiry(value.expires_at)),node('h4','送信する本文（そのまま）'),node('pre',value.exact_draft));
    for(const [decision,title] of [['approve','この外部操作を許可'],['reject','この外部操作を拒否']]){const button=node('button',title);button.type='button';button.disabled=!!externalPending||!credentialReady||Date.parse(value.expires_at)<=Date.now();button.addEventListener('click',()=>void externalDecide(decision));box.append(button);}
    if(!credentialReady)box.append(node('p','先にこの端末の承認用パスキーを登録してください。','notice'));
    byId('external-detail').replaceChildren(box);byId('external-status').textContent=externalPending?'判断結果の照合が必要です。自動で再送しません。':'';
  }catch(error){if(epoch===authEpoch&&selection===externalEpoch){byId('external-detail').replaceChildren();disableExternal(error.auth?'外部操作の閲覧権限がありません。':'外部操作の内容を取得できません。表示を消去しました。');return error.auth?'auth_failed':'unavailable';}}
}
function renderExternalStatus(value,id) {
    const state=value.request_state??value.state,decision=typeof value.decision==='string'?value.decision:value.decision?.kind;
    byId('external-status').textContent='承認ID: '+id+' · 要求: '+externalState(state)+' · 判断: '+(({approve:'許可',reject:'拒否',cancel:'取消',expire:'期限切れ'})[decision]||'未確認')+' · 実行: '+(value.execution?externalState(value.execution.state):'実行成功は未確認');
    if(['approve','reject','cancel','expire'].includes(decision)){externalTracked=id;if(externalPending===id)externalSavePending(null);}else byId('external-status').textContent+='。判断の受理は未確認です。自動再送しません。';
}
async function externalStatus(trackedId) {
  const id=trackedId||externalPending,epoch=authEpoch,selection=externalEpoch;if(!id)return;byId('external-reconcile').disabled=true;
  try{const value=await read('/api/approvals/'+encodeURIComponent(id)+'/status');if(epoch!==authEpoch||selection!==externalEpoch||(id!==externalPending&&id!==externalTracked&&id!==externalSelected))return;
    if(value.request_id!==id||value.operation!==undefined&&value.operation!=='slack.post_thread_reply.v1')throw Error();
    renderExternalStatus(value,id);return value;
  }catch{if(epoch===authEpoch)byId('external-status').textContent='判断結果を照合できません。自動再送せず、接続回復後に状態を確認してください。';}
  finally{byId('external-reconcile').disabled=false;}
}
async function externalDecide(decision) {
  if(externalPending||!externalView||!credentialReady||!csrf||!capabilities.includes('approvals:external'))return;
  const view=externalView,id=externalSelected,epoch=authEpoch,selection=externalEpoch;externalSavePending(id);for(const b of byId('external-detail').querySelectorAll('button'))b.disabled=true;
  let sent=false;
  try{
    const latest=await read('/api/approvals/'+encodeURIComponent(id));if(epoch!==authEpoch||selection!==externalEpoch)return;
    if(!validPresentation(latest,id)||!samePresentation(view,latest)||Date.parse(latest.expires_at)<=Date.now()){externalSavePending(null);disableExternal('表示後に内容が変わったか期限切れです。一覧から選び直してください。');return;}
    const ceremony=await credentialPost('/api/approvals/'+encodeURIComponent(id)+'/options',{decision,presentation_digest:view.presentation_digest});if(epoch!==authEpoch||selection!==externalEpoch)return;
    const json=ceremony.options,publicKey=typeof PublicKeyCredential.parseRequestOptionsFromJSON==='function'?PublicKeyCredential.parseRequestOptionsFromJSON(json):{...json,challenge:fromBase64(json.challenge),allowCredentials:(json.allowCredentials||[]).map(c=>({...c,id:fromBase64(c.id)}))};
    const credential=await navigator.credentials.get({publicKey});if(epoch!==authEpoch||selection!==externalEpoch||!credential)return;
    const response=typeof credential.toJSON==='function'?credential.toJSON():{id:credential.id,rawId:toBase64(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),response:{clientDataJSON:toBase64(credential.response.clientDataJSON),authenticatorData:toBase64(credential.response.authenticatorData),signature:toBase64(credential.response.signature),userHandle:credential.response.userHandle?toBase64(credential.response.userHandle):null}};
    sent=true;const result=await credentialPost('/api/approvals/decide',{ceremony_id:ceremony.ceremony_id,response});if(epoch!==authEpoch)return;
    if(rejected(result,id,'external_approval')){if(externalPending===id)externalSavePending(null);byId('external-status').textContent='この判断は受け付けられませんでした。最新の内容を確認して、改めて判断してください。';if(selection===externalEpoch)void externalSelect();return;}
    if(['decided','reused'].includes(result.status))externalTracked=id;
    byId('external-status').textContent=['decided','reused'].includes(result.status)?'判断を受け付けました。外部操作の実行成功はまだ確認していません。':'判断の受理を確認できません。';await externalStatus();
  }catch(error){if(epoch!==authEpoch)return;if(!sent)byId('external-status').textContent='承認操作が中断されたため、判断は送信していません。';else await externalStatus();}
  finally{if(!sent&&externalPending===id){externalSavePending(null);if(epoch===authEpoch&&!stopped)void externalSelect();}}
}
byId('external-reconcile').addEventListener('click',()=>void externalStatus());
byId('external-next').addEventListener('click',()=>{if(!externalNext)return;externalAfter=externalNext;externalEpoch++;void refresh();});
byId('external-first').addEventListener('click',()=>{externalAfter=null;externalEpoch++;void refresh();});
byId('submit-form').addEventListener('submit',event=>{event.preventDefault();const repository=byId('repository').value.trim(),base=byId('base-ref').value.trim();const workspace=repository?{kind:'github',repository,...(base?{base_ref:base}:{})}:{kind:'scratch'};void command('/api/tasks','create',{objective:byId('objective').value,workspace},byId('submit-task'));});
byId('reconcile').addEventListener('click',()=>{void reconcile();});
byId('pair-form').addEventListener('submit',async event=>{event.preventDefault();const code=byId('code').value;byId('code').value='';const button=byId('pair-submit');button.disabled=true;
  try {const r=await fetch('/api/pair',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
    if(!r.ok)throw Error();generation++;authEpoch++;stream=null;deferredDetail=null;detail.replaceChildren(node('p','接続を確認しています…'));byId('pair-status').textContent='';stopped=false;byId('pairing').hidden=true;byId('logout').hidden=false;void refresh();
  }catch{byId('pair-status').textContent='接続を確認できません。Macで状態を確認し、新しいコードを発行してください。';}finally{button.disabled=false;}
});
byId('logout').addEventListener('click',async()=>{const button=byId('logout');button.disabled=true;
  try{const session=await read('/api/session');if(typeof session.csrf!=='string')throw Error();
    const r=await fetch('/api/logout',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'x-csrf-token':session.csrf}});if(!r.ok)throw Error();clearPrivate('この端末の接続を解除しました。',true);
  }catch{clearPrivate('解除結果を確認できません。Macで接続を失効させてください。',true);}finally{button.disabled=false;}
});
byId('refresh').addEventListener('click',()=>{if(stopped){location.reload();return;}void refresh();});
byId('next').addEventListener('click',()=>{if(!next||polling)return;pageAfter=next;void refresh();});
byId('first').addEventListener('click',()=>{if(polling)return;pageAfter=null;void refresh();});
window.addEventListener('offline',()=>clearPrivate('オフラインです。表示を消去しました。',false));
window.addEventListener('pagehide',()=>{stopped=true;clearPrivate('接続を終了しました。',false);});
window.addEventListener('pageshow',event=>{if(event.persisted){stopped=false;clearPrivate('接続を再確認しています…',false);void refresh();}});
void refresh();setInterval(()=>{if(!document.hidden)void refresh();},5000);
})();`;
const style = `[hidden]{display:none!important}p{overflow-wrap:anywhere}body>section.panel{max-width:1152px;margin:16px auto}#external-items{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}#external-detail>button{margin-right:8px;margin-bottom:8px}@media(max-width:720px){body>section.panel{margin:16px}}:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#101923;color:#eaf0f4}*{box-sizing:border-box}body{margin:0}header,main{max-width:1200px;margin:auto;padding:24px}header{border-bottom:1px solid #405060}h1{font-size:26px;margin:0 0 8px}h2{overflow-wrap:anywhere}h3{margin-top:28px}h4{margin:0 0 12px}.muted{color:#adbfce;font-size:14px}.layout{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,2fr);gap:24px}nav,.panel{background:#182531;border:1px solid #405060;border-radius:12px;padding:20px}button,a{font:inherit}button{cursor:pointer;background:#253747;color:#eaf0f4;border:1px solid #6d8699;border-radius:6px;padding:10px 12px}button:disabled{opacity:.45;cursor:default}button:focus-visible,a:focus-visible{outline:3px solid #8fd8eb;outline-offset:3px}#tasks{display:grid;gap:10px;margin-bottom:20px}#tasks button{text-align:left;overflow-wrap:anywhere}.list-time{display:block;font-size:12px;color:#adbfce;margin-top:6px}#main-conversations{display:grid;gap:10px}#main-conversations button{text-align:left;overflow-wrap:anywhere}summary{cursor:pointer;color:#8fd8eb}h5{margin:14px 0 4px}#main-conversations button[aria-pressed=true],#tasks button[aria-pressed=true]{border-color:#8fd8eb;background:#304c5c}label{display:block;margin:12px 0 6px}input,textarea,select{font:inherit;width:100%;padding:10px;background:#101923;color:#eaf0f4;border:1px solid #6d8699;border-radius:6px}textarea{min-height:100px}fieldset{margin:16px 0;border:1px solid #405060}#submit-panel{margin-top:20px}.controls{display:flex;gap:8px;flex-wrap:wrap}.notice{border-left:3px solid #e2b66f;padding:12px}.messages article{padding:16px;background:#101923;border-radius:8px;margin:12px 0}pre{font:inherit;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}a{color:#8fd8eb}.skip{position:absolute;top:-100px}.skip:focus{top:10px}#connection[data-state=disconnected]{color:#edbd87}@media(max-width:720px){header,main{padding:16px}.layout{grid-template-columns:1fr}.panel,nav{padding:16px}}`;
const digest = (value: string) => createHash("sha256").update(value).digest("base64");
export function observerDashboardPage(): {status: 200; headers: Record<string,string>; body: string} {
  return {status:200,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer",
    "x-content-type-options":"nosniff","x-frame-options":"DENY",
    "content-security-policy":`default-src 'none'; script-src 'sha256-${digest(script)}'; style-src 'sha256-${digest(style)}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`},
    body:`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dona dashboard</title><style>${style}</style></head><body><a class="skip" href="#detail">詳細へ移動</a><header><h1>Dona dashboard</h1><p class="muted">会話と作業状況を確認し、依頼・取消・承認を行えます。Macで付与された権限の範囲で利用できます。</p><p id="connection" role="status" aria-live="polite">接続を確認しています…</p><section id="pairing" hidden><h2>この端末を接続する</h2><p>Macで発行した接続コードを入力すると、Macで付与された範囲の機能を利用できます。Dona本体の会話や操作の権限は、Macで明示的に付与された場合だけ利用できます。</p><form id="pair-form"><label for="code">接続コード</label><input id="code" autocomplete="off" type="password" required maxlength="256"><button id="pair-submit" type="submit">この端末を接続する</button></form><p id="pair-status" role="status"></p></section><button id="logout" type="button">この端末を解除</button><button id="refresh" type="button">更新</button></header><section id="submit-panel" class="panel" hidden><h2>新しい依頼</h2><form id="submit-form"><label for="objective">Donaへの依頼</label><textarea id="objective" required maxlength="100000"></textarea><label for="repository">GitHubリポジトリ（任意）</label><input id="repository" placeholder="owner/repository" pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"><label for="base-ref">開始ブランチ（任意）</label><input id="base-ref" maxlength="255"><p class="muted">リポジトリを指定しない場合は一時作業として実行します。</p><button id="submit-task" type="submit">依頼する</button></form></section><section id="credential-panel" class="panel" hidden><h2>この端末での承認</h2><p id="credential-status" role="status"></p><button id="credential-register" type="button" hidden>承認用パスキーを登録</button></section><section id="external-panel" class="panel" hidden><h2>Donaの外部操作承認</h2><div id="external-items"></div><button id="external-first" type="button">承認一覧の先頭へ</button><button id="external-next" type="button" disabled>承認一覧の次へ</button><div id="external-detail"></div><p id="external-status" role="status"></p><button id="external-reconcile" type="button" hidden>外部操作の状態を確認</button></section><p id="control-hint" hidden>取消するTaskを選ぶには、MacでTask閲覧権限も付与してください。</p><p id="command-status" role="status" aria-live="polite"></p><button id="reconcile" type="button" hidden>受付状況を確認</button><main id="task-layout" class="layout"><nav aria-label="Task一覧"><section id="main-panel" hidden><h2>Dona本体</h2><div id="main-conversations"></div></section><section id="task-panel"><h2>Task一覧</h2><div id="tasks"></div><div class="controls"><button id="first" type="button">先頭へ</button><button id="next" type="button" disabled>次のページ</button></div></section></nav><section id="detail" class="panel" tabindex="-1" aria-label="Taskの詳細"><p>Taskを選ぶと実行履歴と会話を表示します。</p></section></main><script>${script}</script></body></html>`};
}
