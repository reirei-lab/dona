import {expect,test} from '@playwright/test';
import {observerDashboardPage} from '../src/observer-dashboard.js';
for(const kind of ['native','external'] as const)for(const phase of ['options','passkey'] as const)test(`${kind}: ${phase}待ちの選択変更は未送信pendingだけを解除する`,async({page})=>{
 let release!:()=>void,arrived=false,decisions=0,lookups=0;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.addInitScript(()=>{Object.defineProperty(navigator.credentials,'get',{value:()=>new Promise(resolve=>{(window as any).passkeyWaiting=true;(window as any).finishPasskey=()=>resolve(null);})});});
 const tasks=['one','two'].map(id=>({task_id:'task_'+id,task_key:id,state:'waiting',desired_state:'running',revision:1,current_attempt_id:'attempt_'+id,worker_status:'blocked',updated_at:'now'}));
 const expires_at=new Date(Date.now()+600000).toISOString();
 await page.route('https://operator.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/'){await route.fulfill(observerDashboardPage());return;}
  let value:unknown;
  if(path==='/api/session')value={csrf:'csrf',capabilities:kind==='native'?['tasks:read','approvals:native']:['approvals:external']};
  else if(path==='/api/credential')value={registered:true,can_enroll:false};
  else if(path==='/api/tasks')value={items:tasks,next:null};
  else if(path.endsWith('/questions')){const task=tasks.find(t=>path.includes(t.task_id))!;value={task_id:task.task_id,current_attempt_id:task.current_attempt_id,revision:1,questions:[{question_id:'question_'+task.task_id,kind:'approval',state:'pending',request:{method:'item/commandExecution/requestApproval',command:'echo '+task.task_key}}]};}
  else if(path.startsWith('/api/tasks/')){const task=tasks.find(t=>path.includes(t.task_id))!;value={snapshot:{task,attempts:[],selected_attempt_id:task.current_attempt_id},runtime:{status:'not_started'}};}
  else if(path==='/api/approvals')value={available:true,items:['one','two'].map(id=>({request_id:'approval_'+id,operation:'slack.post_thread_reply.v1',state:'requested'})),next:null};
  else if(path.endsWith('/options')){arrived=true;if(phase==='options')await gate;value={ceremony_id:'ceremony',options:{challenge:Buffer.alloc(32,1).toString('base64url'),rpId:'operator.test',allowCredentials:[],userVerification:'required'}};}
  else if(path.endsWith('/decide')){decisions++;value={};}
  else if(path.startsWith('/api/commands/')||path.endsWith('/status')){lookups++;value={receipt:null,request_id:'approval_one',state:'requested',decision:null,execution:null};}
  else value={request_id:path.split('/').at(-1),operation:'slack.post_thread_reply.v1',workspace_id:'T_ONE',channel_id:'C_ONE',thread_ts:'123.456',requester:{kind:'slack',label:'U_REQUESTER'},risk:'external_message',operation_summary:'確認したSlackスレッドへ返信',display_fingerprint:'A1B2C3D4E5F60718',created_at:'2026-10-05T00:00:00.000Z',exact_draft:'表示本文',notified_user_ids:[],expires_at,request_revision:1,presentation_revision:1,presentation_digest:'a'.repeat(64)};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://operator.test/');
 const select=(id:string)=>page.locator(kind==='native'?`[data-task="task_${id}"]`:`[data-external="approval_${id}"]`);
 const approve=()=>page.getByRole('button',{name:kind==='native'?'この要求を許可':'この外部操作を許可'});
 await select('one').click();await approve().click();await expect.poll(()=>arrived).toBe(true);
 if(phase==='passkey')await expect.poll(()=>page.evaluate(()=>(window as any).passkeyWaiting)).toBe(true);
 await select('two').click();await expect(approve()).toBeDisabled();
 if(phase==='options')release();else await page.evaluate(()=>(window as any).finishPasskey());
 const key=kind==='native'?'dona.pending-command':'dona.pending-external';
 await expect.poll(()=>page.evaluate(key=>sessionStorage.getItem(key),key)).toBeNull();
 await expect(approve()).toBeEnabled();await select('one').click();await expect(approve()).toBeEnabled();expect(decisions).toBe(0);expect(lookups).toBe(0);
});

test('外部承認coreの要求状態と実行状態を区別して表示する',async({page})=>{
 const requests={requested:'承認要求を受付済み',delivery_pending:'承認内容の提示待ち',delivery_unknown:'承認内容の提示結果未確認',sent:'承認内容を提示済み',approved:'許可済み',rejected:'拒否済み',cancelled:'取消済み',expired:'期限切れ',delivery_failed:'承認内容の提示失敗',consumed:'判断受付済み',execution_cancelled:'実行取消済み',consume_expired:'実行受付期限切れ',needs_review:'要確認'};
 const executions={claimed:'実行準備中',executing:'実行中',succeeded:'実行成功',failed:'失敗',acceptance_unknown:'送信結果未確認',needs_review:'要確認'};
 let execution='claimed';
 await page.addInitScript(()=>sessionStorage.setItem('dona.pending-external','approval_one'));
 await page.route('https://operator.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;if(path==='/'){await route.fulfill(observerDashboardPage());return;}
  const value=path==='/api/session'?{csrf:'csrf',capabilities:['approvals:external']}:path==='/api/credential'?{registered:true,can_enroll:false}:path.endsWith('/status')?{request_id:'approval_one',state:'consumed',decision:{kind:'approve'},execution:{state:execution}}:{available:true,items:Object.keys(requests).map(state=>({request_id:'request_'+state,operation:'slack.post_thread_reply.v1',state})),next:null};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 for(const [state,label] of Object.entries(executions)){
  execution=state;await page.goto('https://operator.test/');
  for(const label of Object.values(requests))await expect(page.locator('#external-items')).toContainText(label);
  await page.getByRole('button',{name:'外部操作の状態を確認'}).click();await expect(page.locator('#external-status')).toContainText('実行: '+label);
 }
});

for(const kind of ['native','external'] as const)for(const outcome of ['rejected','unknown'] as const)test(`${kind}: decideの確定拒否だけpendingを解除する (${outcome})`,async({page})=>{
 let decisions=0,lookups=0,requestId='';
 await page.addInitScript(()=>{Object.defineProperty(navigator.credentials,'get',{value:async()=>({toJSON(){return {id:'fixture',type:'public-key',response:{}};}})});});
 const tasks=['one','two'].map(id=>({task_id:'task_'+id,task_key:id,state:'waiting',desired_state:'running',revision:1,current_attempt_id:'attempt_'+id,worker_status:'blocked',updated_at:'now'}));
 const expires_at=new Date(Date.now()+600000).toISOString();
 await page.route('https://operator.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/'){await route.fulfill(observerDashboardPage());return;}
  let value:unknown;
  if(path==='/api/session')value={csrf:'csrf',capabilities:kind==='native'?['tasks:read','approvals:native']:['approvals:external']};
  else if(path==='/api/credential')value={registered:true,can_enroll:false};
  else if(path==='/api/tasks')value={items:tasks,next:null};
  else if(path.endsWith('/questions')){const task=tasks.find(t=>path.includes(t.task_id))!;value={task_id:task.task_id,current_attempt_id:task.current_attempt_id,revision:1,questions:[{question_id:'question_'+task.task_id,kind:'approval',state:'pending',request:{method:'item/commandExecution/requestApproval',command:'echo '+task.task_key}}]};}
  else if(path.startsWith('/api/tasks/')){const task=tasks.find(t=>path.includes(t.task_id))!;value={snapshot:{task,attempts:[],selected_attempt_id:task.current_attempt_id},runtime:{status:'not_started'}};}
  else if(path==='/api/approvals')value={available:true,items:['one','two'].map(id=>({request_id:'approval_'+id,operation:'slack.post_thread_reply.v1',state:'requested'})),next:null};
  else if(path.endsWith('/options')){if(kind==='native')requestId=route.request().postDataJSON().input.request_id;value={ceremony_id:'ceremony',options:{challenge:Buffer.alloc(32,1).toString('base64url'),rpId:'operator.test',allowCredentials:[],userVerification:'required'}};}
  else if(path.endsWith('/decide')){decisions++;await route.fulfill({status:outcome==='rejected'?409:503,contentType:'application/json',body:JSON.stringify(outcome==='rejected'?{rejection:{request_id:kind==='native'?requestId:'approval_one',operation:kind==='native'?'native_approval':'external_approval',code:'conflict',not_committed:true}}:{error:'observation_unavailable'})});return;}
  else if(path.startsWith('/api/commands/')||path.endsWith('/status')){lookups++;value={receipt:null,request_id:'approval_one',state:'requested',decision:null,execution:null};}
  else value={request_id:path.split('/').at(-1),operation:'slack.post_thread_reply.v1',workspace_id:'T_ONE',channel_id:'C_ONE',thread_ts:'123.456',requester:{kind:'slack',label:'U_REQUESTER'},risk:'external_message',operation_summary:'確認したSlackスレッドへ返信',display_fingerprint:'A1B2C3D4E5F60718',created_at:'2026-10-05T00:00:00.000Z',exact_draft:'表示本文',notified_user_ids:[],expires_at,request_revision:1,presentation_revision:1,presentation_digest:'a'.repeat(64)};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
 });
 await page.goto('https://operator.test/');
 await page.locator(kind==='native'?'[data-task="task_one"]':'[data-external="approval_one"]').click();
 await page.getByRole('button',{name:kind==='native'?'この要求を許可':'この外部操作を許可'}).click();
 await expect.poll(()=>decisions).toBe(1);
 const key=kind==='native'?'dona.pending-command':'dona.pending-external';
 if(outcome==='rejected'){await expect.poll(()=>page.evaluate(key=>sessionStorage.getItem(key),key)).toBeNull();await expect(page.getByRole('button',{name:kind==='native'?'この要求を許可':'この外部操作を許可'})).toBeEnabled();expect(lookups).toBe(0);}
 else{await expect.poll(()=>lookups).toBeGreaterThan(0);expect(await page.evaluate(key=>sessionStorage.getItem(key),key)).not.toBeNull();}
});
