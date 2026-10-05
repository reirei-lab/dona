import { createHash } from "node:crypto";

/** Read-only observer surface, separate from the OIDC command dashboard.
 * The service authenticates every API read; this module grants no authority. */
const script = String.raw`(() => {
'use strict';
const byId = id => document.getElementById(id);
const list = byId('tasks'), detail = byId('detail'), connection = byId('connection');
let selected = null, generation = 0, pageAfter = null, next = null, stopped = false, polling = false;
const labels = {active:'実行中',capacity_wait:'実行枠の空き待ち',rate_limit_wait:'利用上限の回復待ち',retry_exhausted:'再試行上限',running:'実行中',waiting:'待機中',queued:'実行待ち',paused:'一時停止',completed:'完了',failed:'失敗',cancelled:'取消済み',human_input:'質問への回答待ち',rate_limit:'利用上限の回復待ち',retry_limit:'再試行上限',retry_wait:'再試行待ち',unknown:'状態未確認'};
const label = value => labels[value] || String(value || '未確認');
const node = (tag, text, className) => { const n = document.createElement(tag); if(text !== undefined) n.textContent = String(text); if(className) n.className = className; return n; };
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
function clearPrivate(message, auth) {
  generation++; list.replaceChildren(); detail.replaceChildren(node('p',message)); next = null; byId('next').disabled = true;
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
  if(!task || task.task_id!==selected || !Array.isArray(value.snapshot.attempts)) throw Error();
  const content = document.createDocumentFragment();
  content.append(node('h2',task.task_id),node('p','Task: '+label(task.state)+(task.wait_reason?' · '+label(task.wait_reason):''),'state'));
  content.append(node('p','ワーカー: '+label(task.worker_status)+' · 更新 '+task.updated_at,'muted'));
  content.append(node('h3','実行履歴'));
  const attempts = node('ol');
  for(const attempt of value.snapshot.attempts) attempts.append(node('li','Attempt '+attempt.number+' · '+label(attempt.status)+(attempt.outcome?' · '+label(attempt.outcome):'')));
  content.append(attempts,node('h3','ワーカーの会話'));
  const runtime = value.runtime;
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
  detail.replaceChildren(content);
}
async function detailRead() {
  if(!selected || stopped) return;
  const id=selected, token=++generation;
  try { const value=await read('/api/tasks/'+encodeURIComponent(id)); if(token!==generation || id!==selected || stopped)return; renderDetail(value); }
  catch(error) { if(token!==generation || id!==selected || stopped)return; clearPrivate(error.auth?'接続の認証が必要です。':'接続が切れています。表示を消去しました。',error.auth); }
}
function renderList(value) {
  if(!Array.isArray(value?.items) || (value.next!==null && !validId(value.next))) throw Error();
  const focused=document.activeElement?.dataset?.task;
  const content=document.createDocumentFragment();
  for(const task of value.items) {
    if(!validId(task.task_id)) throw Error();
    const button=node('button',task.task_id+' · '+label(task.state)); button.type='button'; button.dataset.task=task.task_id;
    button.setAttribute('aria-pressed',String(task.task_id===selected));
    button.addEventListener('click',()=> {selected=task.task_id; generation++; detail.replaceChildren(node('p','会話を取得しています…'));
      for(const b of list.querySelectorAll('button')) b.setAttribute('aria-pressed',String(b.dataset.task===selected)); void detailRead(); });
    content.append(button);
  }
  if(value.items.length===0)content.append(node('p','表示できるTaskはありません。','muted'));
  list.replaceChildren(content); if(focused) Array.from(list.querySelectorAll('button')).find(b=>b.dataset.task===focused)?.focus({preventScroll:true});
  next=value.next; byId('next').disabled=next===null;
}
async function refresh() {
  if(polling || stopped)return; polling=true; const token=generation;
  try {const value=await read('/api/tasks'+(pageAfter?'?after='+encodeURIComponent(pageAfter):''));
    if(token!==generation || stopped)return; renderList(value); connection.textContent='接続中 · 5秒ごとに更新';connection.dataset.state='connected';
    await detailRead();
  } catch(error) {if(token===generation && !stopped)clearPrivate(error.auth?'接続の認証が必要です。':'接続が切れています。表示を消去しました。',error.auth);}
  finally {polling=false;}
}
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
const style = `:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#101923;color:#eaf0f4}*{box-sizing:border-box}body{margin:0}header,main{max-width:1200px;margin:auto;padding:24px}header{border-bottom:1px solid #405060}h1{font-size:26px;margin:0 0 8px}h2{overflow-wrap:anywhere}h3{margin-top:28px}h4{margin:0 0 12px}.muted{color:#adbfce;font-size:14px}.layout{display:grid;grid-template-columns:minmax(220px,1fr) minmax(0,2fr);gap:24px}nav,.panel{background:#182531;border:1px solid #405060;border-radius:12px;padding:20px}button,a{font:inherit}button{cursor:pointer;background:#253747;color:#eaf0f4;border:1px solid #6d8699;border-radius:6px;padding:10px 12px}button:disabled{opacity:.45;cursor:default}button:focus-visible,a:focus-visible{outline:3px solid #8fd8eb;outline-offset:3px}#tasks{display:grid;gap:10px;margin-bottom:20px}#tasks button{text-align:left;overflow-wrap:anywhere}#tasks button[aria-pressed=true]{border-color:#8fd8eb;background:#304c5c}.controls{display:flex;gap:8px;flex-wrap:wrap}.notice{border-left:3px solid #e2b66f;padding:12px}.messages article{padding:16px;background:#101923;border-radius:8px;margin:12px 0}pre{font:inherit;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}a{color:#8fd8eb}.skip{position:absolute;top:-100px}.skip:focus{top:10px}#connection[data-state=disconnected]{color:#edbd87}@media(max-width:720px){header,main{padding:16px}.layout{grid-template-columns:1fr}.panel,nav{padding:16px}}`;
const digest = (value: string) => createHash("sha256").update(value).digest("base64");
export function observerDashboardPage(): {status: 200; headers: Record<string,string>; body: string} {
  return {status:200,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer",
    "x-content-type-options":"nosniff","x-frame-options":"DENY",
    "content-security-policy":`default-src 'none'; script-src 'sha256-${digest(script)}'; style-src 'sha256-${digest(style)}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`},
    body:`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dona · 作業の観測</title><style>${style}</style></head><body><a class="skip" href="#detail">詳細へ移動</a><header><h1>Dona · 作業の観測</h1><p class="muted">Taskとワーカーの進行状況を閲覧します。作業の実行・取消・質問への回答はSlackで行ってください。</p><p id="connection" role="status" aria-live="polite">接続を確認しています…</p><section id="pairing" hidden><h2>この端末を接続する</h2><p>Macで発行した接続コードを入力すると、このDonaのすべてのTaskとワーカーの会話を閲覧できます。実行・変更の権限は付与されません。</p><form id="pair-form"><label for="code">接続コード</label><input id="code" autocomplete="off" type="password" required maxlength="256"><button id="pair-submit" type="submit">閲覧用に接続する</button></form><p id="pair-status" role="status"></p></section><button id="logout" type="button">この端末を解除</button><button id="refresh" type="button">更新</button></header><main class="layout"><nav aria-label="Task一覧"><h2>Task一覧</h2><div id="tasks"></div><div class="controls"><button id="first" type="button">先頭へ</button><button id="next" type="button" disabled>次のページ</button></div></nav><section id="detail" class="panel" tabindex="-1" aria-label="Taskの詳細"><p>Taskを選ぶと実行履歴と会話を表示します。</p></section></main><script>${script}</script></body></html>`};
}
