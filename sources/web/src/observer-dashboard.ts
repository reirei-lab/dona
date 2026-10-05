import { createHash } from "node:crypto";

/** Paired operator dashboard.
 * The service authenticates every API read; this module grants no authority. */
const script = String.raw`(() => {
'use strict';
const byId = id => document.getElementById(id);
const list = byId('tasks'), detail = byId('detail'), connection = byId('connection');
let csrf=null, authEpoch=0;
let pending=(()=>{try{return JSON.parse(sessionStorage.getItem("dona.pending-command")||"null");}catch{return null;}})();
let selected = null, selectedAttempt = null, selectedMain = null, capabilities = [], generation = 0, pageAfter = null, next = null, stopped = false, polling = false;
const labels = {preparing:'実行準備中',dispatching:'起動処理中',blocked:'入力・承認待ち',needs_review:'確認が必要',cancelling:'取消処理中',inProgress:'進行中',declined:'拒否済み',active:'実行中',capacity_wait:'実行枠の空き待ち',rate_limit_wait:'利用上限の回復待ち',retry_exhausted:'再試行上限',running:'実行中',waiting:'待機中',queued:'実行待ち',paused:'一時停止',completed:'完了',failed:'失敗',cancelled:'取消済み',human_input:'質問への回答待ち',rate_limit:'利用上限の回復待ち',retry_limit:'再試行上限',retry_wait:'再試行待ち',unknown:'状態未確認'};
const label = value => labels[value] || String(value || '未確認');
const node = (tag, text, className) => { const n = document.createElement(tag); if(text !== undefined) n.textContent = String(text); if(className) n.className = className; return n; };
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
function clearPrivate(message, auth) {
  generation++; authEpoch++; byId("objective").value=""; byId("repository").value=""; byId("base-ref").value=""; csrf=null; capabilities=[]; byId("credential-panel").hidden=true; byId("submit-panel").hidden=true; byId("task-panel").hidden=true; byId("command-status").textContent=""; byId('main-conversations').replaceChildren(); byId('main-panel').hidden=true; list.replaceChildren(); detail.replaceChildren(node('p',message)); next = null; byId('next').disabled = true;
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
  if(document.activeElement?.closest('[data-question-form]'))return;
  const content = document.createDocumentFragment();
  content.append(node('h2',task.task_key || task.task_id),node('p',task.task_id,'muted'),node('p','Task: '+label(task.state)+(task.wait_reason?' · '+label(task.wait_reason):''),'state'));
  content.append(node('p','ワーカー: '+label(task.worker_status)+' · 更新 '+task.updated_at,'muted'));
  if(capabilities.includes('tasks:cancel') && task.desired_state==='running' && !['completed','failed','cancelled'].includes(task.state)) {
    const button=node('button','このTaskを取り消す');button.type='button';button.disabled=!!pending;
    button.addEventListener('click',()=>{if(!confirm('このTaskの実行を取り消しますか？ 停止確認が完了するまで取消処理中になります。'))return;void command('/api/tasks/'+encodeURIComponent(task.task_id)+'/cancel','cancel',{attempt_id:task.current_attempt_id,revision:task.revision},button);});content.append(button);
  }
  const questions=node('section');questions.dataset.questions=task.task_id;content.append(questions);
  if(capabilities.includes('tasks:submit') && task.desired_state==='running')void loadQuestions(task.task_id,questions);
  content.append(node('h3','実行履歴'));
  const attempts = node('ol');
  for(const attempt of value.snapshot.attempts) {
    const item=node('li'),button=node('button','Attempt '+attempt.number+' · '+label(attempt.status)+(attempt.outcome?' · '+label(attempt.outcome):''));button.type='button';button.dataset.attempt=attempt.attempt_id;
    button.setAttribute('aria-pressed',String(attempt.attempt_id===(selectedAttempt || value.snapshot.selected_attempt_id || task.current_attempt_id)));
    button.disabled=!validId(attempt.attempt_id);
    button.addEventListener('click',()=>{selectedAttempt=attempt.attempt_id;generation++;detail.replaceChildren(node('p','実行履歴を取得しています…'));void detailRead();});item.append(button);attempts.append(item);
  }
  content.append(attempts,node('h3','ワーカーの会話'));
  if(task.next_check_at)content.append(node('p','次の確認予定: '+task.next_check_at,'muted'));
  if(value.snapshot.result) {
    const result=value.snapshot.result;content.append(node('h3','実行結果'),node('p',result.completed_at,'muted'),node('pre',result.summary));
    if(result.output)content.append(node('pre',result.output));
    for(const artifact of result.artifacts || [])content.append(node('p',artifact.display_name+' · '+artifact.kind));
  }
  appendConversation(content,value.runtime);
  const focus=document.activeElement?.dataset?.attempt;detail.replaceChildren(content);if(focus)Array.from(detail.querySelectorAll('button')).find(b=>b.dataset.attempt===focus)?.focus({preventScroll:true});
}
function appendConversation(content,runtime) {

  if(runtime?.status==='observed') {
    const c = runtime.conversation;
    if(!Array.isArray(c.items)) throw Error();
    content.append(node('p',(c.connected?'Runtime接続中':'Runtime接続なし')+' · 観測 '+c.observed_at,'muted'));
    if(c.gap || c.truncated) content.append(node('p','履歴の一部は保持期間または表示上限のため省略されています。','notice'));
    if(c.items.length===0) content.append(node('p','表示できる発言はまだありません。','muted'));
    const messages = node('div',undefined,'messages');
    for(const item of c.items) {
      if(!['assistant_message','tool_progress'].includes(item.kind)) continue;
      const entry = node('article'); entry.append(node('h4',item.kind==='assistant_message'?'Codex':'ツールの進捗'));
      if(item.text) entry.append(node('pre',item.text)); if(item.status) entry.append(node('p',label(item.status),'muted'));
      messages.append(entry);
    }
    content.append(messages);
  } else content.append(node('p',({unavailable:'会話を現在取得できません。Taskの状態とは別の接続状態です。',not_started:'会話はまだ開始されていません。',forbidden:'この接続では会話の閲覧が許可されていません。'})[runtime?.status] || '会話の状態を確認できません。','notice'));
}
async function detailRead() {
  if(!selected || stopped) return;
  const id=selected, token=++generation;
  try { const value=await read('/api/tasks/'+encodeURIComponent(id)+(selectedAttempt?'?attempt='+encodeURIComponent(selectedAttempt):'')); if(token!==generation || id!==selected || stopped)return; renderDetail(value); }
  catch(error) { if(token!==generation || id!==selected || stopped)return; clearPrivate(error.auth?'接続の認証が必要です。':'接続が切れています。表示を消去しました。',error.auth); }
}
function renderList(value) {
  if(!Array.isArray(value?.items) || (value.next!==null && !validId(value.next))) throw Error();
  const focused=document.activeElement?.dataset?.task;
  const content=document.createDocumentFragment();
  for(const task of value.items) {
    if(!validId(task.task_id)) throw Error();
    const button=node('button',(task.task_key || task.task_id)+' · '+label(task.state)); button.type='button'; button.dataset.task=task.task_id;
    button.setAttribute('aria-pressed',String(task.task_id===selected));
    button.addEventListener('click',()=> {selected=task.task_id; selectedAttempt=null;selectedMain=null; generation++; detail.replaceChildren(node('p','会話を取得しています…'));
      for(const b of list.querySelectorAll('button')) b.setAttribute('aria-pressed',String(b.dataset.task===selected)); void detailRead(); });
    content.append(button);
  }
  if(value.items.length===0)content.append(node('p','表示できるTaskはありません。','muted'));
  list.replaceChildren(content); if(focused) Array.from(list.querySelectorAll('button')).find(b=>b.dataset.task===focused)?.focus({preventScroll:true});
  next=value.next; byId('next').disabled=next===null;
}
async function refresh() {
  if(polling || stopped)return; polling=true; const token=generation;
  try {const session=await read('/api/session');if(token!==generation || stopped)return;capabilities=Array.isArray(session.capabilities)?session.capabilities:[];csrf=typeof session.csrf==='string'?session.csrf:null;
    byId('submit-panel').hidden=!capabilities.includes('tasks:submit');byId('task-panel').hidden=!capabilities.includes('tasks:read');byId('control-hint').hidden=capabilities.includes('tasks:read')||!capabilities.includes('tasks:cancel');
    byId('submit-task').disabled=!!pending;showPending();await credentialStatus();await mainList();
    if(capabilities.includes('tasks:read')) {const value=await read('/api/tasks'+(pageAfter?'?after='+encodeURIComponent(pageAfter):''));if(token!==generation || stopped)return;renderList(value);}
    if(token!==generation || stopped)return; connection.textContent='接続中 · 5秒ごとに更新';connection.dataset.state='connected';
    if(selectedMain)await mainRead();else if(capabilities.includes('tasks:read'))await detailRead();
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
    const button=node('button',entry.name+' · '+entry.generation+(entry.connected?' · 接続中':' · 保存された履歴'));button.type='button';button.dataset.main=entry.name+':'+entry.generation;
    button.addEventListener('click',()=>{selectedMain={name:entry.name,generation:entry.generation};selected=null;selectedAttempt=null;generation++;detail.replaceChildren(node('p','Dona本体の会話を取得しています…'));void mainRead();});box.append(button);
  }
  const focused=document.activeElement?.dataset?.main;byId('main-conversations').replaceChildren(box);
  if(focused)Array.from(byId('main-conversations').querySelectorAll('button')).find(b=>b.dataset.main===focused)?.focus({preventScroll:true});
}
async function mainRead() {
  if(!selectedMain||stopped)return;const target=selectedMain,token=++generation;
  try {const value=await read('/api/conversations/main/'+encodeURIComponent(target.name)+'/'+encodeURIComponent(target.generation));if(token!==generation||selectedMain!==target||stopped)return;
    const content=document.createDocumentFragment();content.append(node('h2','Dona本体の会話'),node('p','このDona全体にまたがる発言です。特定のTaskの会話ではありません。','notice'));appendConversation(content,value);detail.replaceChildren(content);
  }catch(error){if(token===generation&&!stopped)clearPrivate(error.auth?'接続の認証が必要です。':'接続が切れています。表示を消去しました。',error.auth);}
}
const fromBase64=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const toBase64=value=>btoa(String.fromCharCode(...new Uint8Array(value))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
async function credentialStatus() {
  const allowed=capabilities.includes('approvals:native')||capabilities.includes('approvals:external');byId('credential-panel').hidden=!allowed;if(!allowed)return;
  const epoch=authEpoch;
  try {const state=await read('/api/credential');if(epoch!==authEpoch)return;byId('credential-status').textContent=state.registered?'この端末の承認用パスキーは登録済みです。':state.can_enroll?'承認操作には、この端末のパスキー登録が必要です。':'登録可能な時間を過ぎました。Macで新しい接続コードを発行してください。';byId('credential-register').hidden=state.registered||!state.can_enroll;}
  catch {if(epoch===authEpoch){byId('credential-status').textContent='パスキー登録状態を確認できません。';byId('credential-register').hidden=true;}}
}
async function credentialPost(url,body) {
  if(!csrf)throw Error();const response=await fetch(url,{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify(body)});if(!response.ok)throw Error();return response.json();
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
function accepted(value) {
  if(!value?.receipt || !pending || value.receipt.request_id!==pending.request_id || value.receipt.operation!==pending.operation)throw Error();
  const receipt=value.receipt;savePending(null);byId('command-status').textContent=(receipt.operation==='cancel'?'取消を受け付けました。停止完了はTaskの状態で確認してください。':receipt.operation==='question_reply'?'回答を受け付けました。Donaがワーカーへ届けます。':'依頼を受け付けました。')+' Task: '+receipt.task_id;
  if(capabilities.includes('tasks:read')){selected=receipt.task_id;selectedAttempt=null;selectedMain=null;void detailRead();}
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
    if(!response.ok)throw Error();accepted(await response.json());
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
byId('submit-form').addEventListener('submit',event=>{event.preventDefault();const repository=byId('repository').value.trim(),base=byId('base-ref').value.trim();const workspace=repository?{kind:'github',repository,...(base?{base_ref:base}:{})}:{kind:'scratch'};void command('/api/tasks','create',{objective:byId('objective').value,workspace},byId('submit-task'));});
byId('reconcile').addEventListener('click',()=>{void reconcile();});
byId('pair-form').addEventListener('submit',async event=>{event.preventDefault();const code=byId('code').value;byId('code').value='';const button=byId('pair-submit');button.disabled=true;
  try {const r=await fetch('/api/pair',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
    if(!r.ok)throw Error();stopped=false;byId('pairing').hidden=true;byId('logout').hidden=false;void refresh();
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
const style = `:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#101923;color:#eaf0f4}*{box-sizing:border-box}body{margin:0}header,main{max-width:1200px;margin:auto;padding:24px}header{border-bottom:1px solid #405060}h1{font-size:26px;margin:0 0 8px}h2{overflow-wrap:anywhere}h3{margin-top:28px}h4{margin:0 0 12px}.muted{color:#adbfce;font-size:14px}.layout{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,2fr);gap:24px}nav,.panel{background:#182531;border:1px solid #405060;border-radius:12px;padding:20px}button,a{font:inherit}button{cursor:pointer;background:#253747;color:#eaf0f4;border:1px solid #6d8699;border-radius:6px;padding:10px 12px}button:disabled{opacity:.45;cursor:default}button:focus-visible,a:focus-visible{outline:3px solid #8fd8eb;outline-offset:3px}#tasks{display:grid;gap:10px;margin-bottom:20px}#tasks button{text-align:left;overflow-wrap:anywhere}#tasks button[aria-pressed=true]{border-color:#8fd8eb;background:#304c5c}label{display:block;margin:12px 0 6px}input,textarea,select{font:inherit;width:100%;padding:10px;background:#101923;color:#eaf0f4;border:1px solid #6d8699;border-radius:6px}textarea{min-height:100px}fieldset{margin:16px 0;border:1px solid #405060}#submit-panel{margin-top:20px}.controls{display:flex;gap:8px;flex-wrap:wrap}.notice{border-left:3px solid #e2b66f;padding:12px}.messages article{padding:16px;background:#101923;border-radius:8px;margin:12px 0}pre{font:inherit;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}a{color:#8fd8eb}.skip{position:absolute;top:-100px}.skip:focus{top:10px}#connection[data-state=disconnected]{color:#edbd87}@media(max-width:720px){header,main{padding:16px}.layout{grid-template-columns:1fr}.panel,nav{padding:16px}}`;
const digest = (value: string) => createHash("sha256").update(value).digest("base64");
export function observerDashboardPage(): {status: 200; headers: Record<string,string>; body: string} {
  return {status:200,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer",
    "x-content-type-options":"nosniff","x-frame-options":"DENY",
    "content-security-policy":`default-src 'none'; script-src 'sha256-${digest(script)}'; style-src 'sha256-${digest(style)}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`},
    body:`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dona · 作業の観測</title><style>${style}</style></head><body><a class="skip" href="#detail">詳細へ移動</a><header><h1>Dona · 作業の観測</h1><p class="muted">Taskとワーカーの進行状況を閲覧します。Macで付与された権限の範囲で利用できます。</p><p id="connection" role="status" aria-live="polite">接続を確認しています…</p><section id="pairing" hidden><h2>この端末を接続する</h2><p>Macで発行した接続コードを入力すると、Macで付与された範囲の機能を利用できます。Dona本体の会話や操作の権限は、Macで明示的に付与された場合だけ利用できます。</p><form id="pair-form"><label for="code">接続コード</label><input id="code" autocomplete="off" type="password" required maxlength="256"><button id="pair-submit" type="submit">この端末を接続する</button></form><p id="pair-status" role="status"></p></section><button id="logout" type="button">この端末を解除</button><button id="refresh" type="button">更新</button></header><section id="submit-panel" class="panel" hidden><h2>新しい依頼</h2><form id="submit-form"><label for="objective">Donaへの依頼</label><textarea id="objective" required maxlength="100000"></textarea><label for="repository">GitHubリポジトリ（任意）</label><input id="repository" placeholder="owner/repository" pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"><label for="base-ref">開始ブランチ（任意）</label><input id="base-ref" maxlength="255"><p class="muted">リポジトリを指定しない場合は一時作業として実行します。</p><button id="submit-task" type="submit">依頼する</button></form></section><section id="credential-panel" class="panel" hidden><h2>この端末での承認</h2><p id="credential-status" role="status"></p><button id="credential-register" type="button" hidden>承認用パスキーを登録</button></section><p id="control-hint" hidden>取消するTaskを選ぶには、MacでTask閲覧権限も付与してください。</p><p id="command-status" role="status" aria-live="polite"></p><button id="reconcile" type="button" hidden>受付状況を確認</button><main class="layout"><nav aria-label="Task一覧"><section id="main-panel" hidden><h2>Dona本体</h2><div id="main-conversations"></div></section><section id="task-panel"><h2>Task一覧</h2><div id="tasks"></div><div class="controls"><button id="first" type="button">先頭へ</button><button id="next" type="button" disabled>次のページ</button></div></section></nav><section id="detail" class="panel" tabindex="-1" aria-label="Taskの詳細"><p>Taskを選ぶと実行履歴と会話を表示します。</p></section></main><script>${script}</script></body></html>`};
}
