import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { DispatcherDatabase } from "../src/database.js";
import { taskRequestSchema } from "../src/task-execution.js";
import { DashboardObserver, type ConversationContent, type DashboardAuthority } from "../src/dashboard/observer.js";
import { DashboardTaskReader } from "../src/dashboard/task-reader.js";
import { eventEnvelope, tempConfig } from "./helpers.js";

test("観測readerは非公開Taskを除いてからpageを作り、実行DBを変更しない", async () => {
  const {root, config} = await tempConfig();
  const db = new DispatcherDatabase(config.databasePath);
  let reader: DashboardTaskReader | undefined;
  try {
    const event = db.enqueue(eventEnvelope("dashboard-observation")).row;
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const request = taskRequestSchema.parse({source_event_id:event.event_id,task_key:`observe-${i}`,objective:"secret objective /private/path token",workspace:{kind:"scratch"}});
      ids.push(db.tasks.create(request,config.jobsWorkspaceRoot,config.jobResultsDir).task.task_id);
    }
    ids.sort().reverse();
    reader = new DashboardTaskReader(config.databasePath);
    const before = ids.map(id => db.tasks.get(id));
    const first = reader.list(task => task.task_id !== ids[0],null,2);
    assert.deepEqual(first.items.map(task=>task.task_id),ids.slice(1,3));
    assert.equal(first.next,ids[2]);
    const second = reader.list(task=>task.task_id!==ids[0],first.next,2);
    assert.deepEqual(second.items.map(task=>task.task_id),ids.slice(3));
    assert.equal(second.next,null);
    const snapshot = reader.snapshot(ids[1]!)!;
    assert.equal(snapshot.attempts.length,1);
    assert.equal(snapshot.attempts[0]!.attempt_id,snapshot.task.current_attempt_id);
    assert.equal(snapshot.request,"secret objective /private/path token");
    assert.equal(JSON.stringify(first).includes("secret objective"),false);
    assert.equal(JSON.stringify(snapshot).includes(config.jobsWorkspaceRoot),false);
    assert.deepEqual(ids.map(id=>db.tasks.get(id)),before);
    assert.throws(()=>reader!.list(()=>true,null,51),/query_invalid/);
    assert.equal(reader.snapshot("unknown"),null);
    assert.throws(()=>new DashboardTaskReader(`${root}/absent.sqlite3`));
  } finally { reader?.close();db.close();await fs.rm(root,{recursive:true,force:true}); }
});

test("会話権限がない端末の応答は依頼本文だけの変更に依存しない", async () => {
  const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
  const {default:Database}=await import("better-sqlite3"),sql=new Database(config.databasePath);
  let reader:DashboardTaskReader|undefined;
  try {
    const event=db.enqueue(eventEnvelope("private-request-fingerprint")).row;
    const task=db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:"private-request",objective:"非公開の候補A",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
    reader=new DashboardTaskReader(config.databasePath);
    const observer=new DashboardObserver(reader,{async conversations(){throw Error("must not read");},async conversation(){throw Error("must not read");}});
    const authority=()=>({revision:"1",task:()=>true,conversation:()=>false});
    const before=await observer.detail(task.task_id,authority);
    sql.prepare("UPDATE tasks SET objective=? WHERE task_id=?").run("非公開の候補B",task.task_id);
    const after=await observer.detail(task.task_id,authority);
    assert.equal(reader.snapshot(task.task_id)!.request,"非公開の候補B");
    assert.deepEqual(after,before);
    assert.equal(after!.snapshot.request,undefined);
  } finally {reader?.close();sql.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("会話取得中の失効・Attempt変更は古い本文を返さず、切断をTask失敗にしない", async () => {
  const {root, config} = await tempConfig();
  const db = new DispatcherDatabase(config.databasePath);
  let reader: DashboardTaskReader | undefined;
  try {
    const event = db.enqueue(eventEnvelope("dashboard-races")).row;
    const task = db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:"observe",objective:"観測",workspace:{kind:"scratch"}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
    reader = new DashboardTaskReader(config.databasePath);
    let authority: DashboardAuthority | null = {revision:"1",task:()=>true,conversation:()=>true};
    const content: ConversationContent = {name:db.getJob(task.current_attempt_id)!.agent_name,generation:"g1",role:"worker",thread_id:"thread",attempt_id:task.current_attempt_id,connected:true,observed_at:new Date().toISOString(),state:"working",items:[],events:[],cursor:1,oldest_sequence:1,gap:false,truncated:false};
    db.beginJobPreparation(task.current_attempt_id);
    db.setJobRuntime(task.current_attempt_id,"workspace","pane",JSON.stringify([content.generation,content.thread_id]));
    let action = () => {};
    const observer = new DashboardObserver(reader,{async conversations(){return {items:[content],next:null};},async conversation(){action();return content;}});
    (content as unknown as Record<string,unknown>).raw_tool_arguments="private tool input";
    content.items=[{id:"item",turn_id:"turn",kind:"tool_progress",text:"private tool output",status:"completed"}];
    const initial=await observer.detail(task.task_id,()=>authority);
    assert.equal(initial!.runtime.status,"observed");
    assert.equal(JSON.stringify(initial).includes("private tool"),false);
    const {default:Database}=await import("better-sqlite3"),sql=new Database(config.databasePath);
    try {
      action=()=>{sql.prepare("UPDATE tasks SET objective=? WHERE task_id=?").run("変更された依頼",task.task_id);};
      const changedRequest=await observer.detail(task.task_id,()=>authority);
      assert.equal(changedRequest!.runtime.status,"unavailable");
      assert.equal(changedRequest!.snapshot.request,"変更された依頼");
    } finally {sql.close();}
    action=()=>{authority=null;};
    assert.equal(await observer.detail(task.task_id,()=>authority),null);
    authority={revision:"2",task:()=>true,conversation:()=>true};
    action=()=>{db.tasks.wait(db.tasks.get(task.task_id)!,"human_input",1000);};
    const changed=await observer.detail(task.task_id,()=>authority);
    assert.equal(changed!.runtime.status,"unavailable");
    assert.equal(changed!.snapshot.task.wait_reason,"human_input");
    action=()=>{throw Error("network disconnected");};
    const offline=await observer.detail(task.task_id,()=>authority);
    assert.equal(offline!.runtime.status,"unavailable");
    assert.equal(offline!.snapshot.task.state,"waiting");
    authority={revision:"3",task:()=>true,conversation:()=>false};
    const forbidden=await observer.detail(task.task_id,()=>authority);
    assert.equal(forbidden!.runtime.status,"forbidden");
    assert.equal(forbidden!.snapshot.request,undefined);
  } finally {reader?.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("会話はdurable generation/threadへ束縛し、bindingの欠落・不一致・取得中の変更で本文を返さない",async()=>{
  const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);let reader:DashboardTaskReader|undefined;
  try{
    const event=db.enqueue(eventEnvelope('observer-durable-binding')).row;
    const task=db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:'binding',objective:'観測',workspace:{kind:'scratch'}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
    db.beginJobPreparation(task.current_attempt_id);reader=new DashboardTaskReader(config.databasePath);
    const authority=()=>({revision:'1',task:()=>true,conversation:()=>true});
    const content:ConversationContent={name:db.getJob(task.current_attempt_id)!.agent_name,generation:'generation_one',thread_id:'thread_one',role:'worker',attempt_id:task.current_attempt_id,connected:true,observed_at:new Date().toISOString(),state:'working',items:[{id:'item',turn_id:'turn',kind:'assistant_message',text:'private history'}],events:[],cursor:0,oldest_sequence:0,gap:false,truncated:false};
    let inventoryCalls=0,historyCalls=0,change=()=>{},history=()=>content;
    const observer=new DashboardObserver(reader,{async conversations(){inventoryCalls++;return{items:[content],next:null};},async conversation(){historyCalls++;change();return history();}});
    assert.equal((await observer.detail(task.task_id,authority))!.runtime.status,'unavailable');assert.equal(inventoryCalls,0);
    const bind=(generation:string,thread:string)=>db.setJobRuntime(task.current_attempt_id,'workspace','pane',JSON.stringify([generation,thread]));
    db.setJobRuntime(task.current_attempt_id,'workspace','pane','legacy-unverified-identity');
    assert.equal((await observer.detail(task.task_id,authority))!.runtime.status,'unavailable');assert.equal(inventoryCalls,0);
    bind('generation_wrong','thread_one');assert.equal((await observer.detail(task.task_id,authority))!.runtime.status,'unavailable');assert.equal(historyCalls,1);
    bind('generation_other','thread_wrong');assert.equal((await observer.detail(task.task_id,authority))!.runtime.status,'unavailable');assert.equal(historyCalls,2);
    bind('generation_one','thread_one');
    const good=await observer.detail(task.task_id,authority);assert.equal(good!.runtime.status,'observed');assert.equal(JSON.stringify(good).includes('runtime_binding'),false);assert.equal(JSON.stringify(good).includes('herdr_agent_session_id'),false);
    history=()=>({...content,thread_id:'thread_wrong'});assert.equal((await observer.detail(task.task_id,authority))!.runtime.status,'unavailable');history=()=>content;
    const before=reader.snapshot(task.task_id)!;
    change=()=>bind('generation_two','thread_two');
    const changed=await observer.detail(task.task_id,authority);assert.equal(changed!.runtime.status,'unavailable');assert.equal(JSON.stringify(changed).includes('private history'),false);
    const after=reader.snapshot(task.task_id)!;assert.notEqual(before.fingerprint,after.fingerprint);assert.deepEqual(before.task,after.task);assert.deepEqual(before.attempts,after.attempts);
  }finally{reader?.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("会話未開始はidentity未登録のqueuedだけとし、準備済み・terminal・inventory不在を取得不能と区別する",async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);let reader:DashboardTaskReader|undefined;
 try{
  const event=db.enqueue(eventEnvelope('observer-started-meaning')).row;
  const create=(key:string)=>db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:key,objective:'観測',workspace:{kind:'scratch'}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
  const task=create('meaning');reader=new DashboardTaskReader(config.databasePath);let calls=0;
  const observer=new DashboardObserver(reader,{async conversations(){calls++;return{items:[],next:null};},async conversation(){calls++;throw Error('history unavailable');}});
  const authority=()=>({revision:'1',task:()=>true,conversation:()=>true});
  assert.equal((await observer.detail(task.task_id,authority))!.runtime.status,'not_started');assert.equal(calls,0);
  db.beginJobPreparation(task.current_attempt_id);
  assert.equal((await observer.detail(task.task_id,authority))!.runtime.status,'unavailable');assert.equal(calls,0);
  db.setJobRuntime(task.current_attempt_id,'workspace','pane','["malformed"]');
  assert.equal((await observer.detail(task.task_id,authority))!.runtime.status,'unavailable');assert.equal(calls,0);
  db.setJobRuntime(task.current_attempt_id,'workspace','pane',JSON.stringify(['generation','thread']));
  const absent=await observer.detail(task.task_id,authority);assert.equal(absent!.runtime.status,'unavailable');assert.equal(calls,1);assert.equal(JSON.stringify(absent).includes('runtime_binding'),false);
  db.recordJobPreparationFailure(task.current_attempt_id,'failed','fixture failure',1);
  assert.equal((await observer.detail(task.task_id,authority))!.runtime.status,'unavailable');assert.equal(calls,2);
  const failedWithoutBinding=create('failed-without-binding');db.beginJobPreparation(failedWithoutBinding.current_attempt_id);db.recordJobPreparationFailure(failedWithoutBinding.current_attempt_id,'failed','fixture failure',1);
  assert.equal((await observer.detail(failedWithoutBinding.task_id,authority))!.runtime.status,'unavailable');assert.equal(calls,2);
 }finally{reader?.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});

test('cleanup後の過去AttemptをTask所属とarchiveへ束縛しResultを許可された本文だけへ投影する',async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);let reader:DashboardTaskReader|undefined;
 const {default:Database}=await import('better-sqlite3');
 try {
  const event=db.enqueue(eventEnvelope('observer-history')).row;
  const create=(key:string)=>db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:key,objective:'観測',workspace:{kind:'scratch'}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
  const task=create('history'),foreign=create('foreign');db.beginJobPreparation(task.current_attempt_id);
  db.setJobRuntime(task.current_attempt_id,'workspace','pane',JSON.stringify(['generation','thread']));
  db.markJobRuntimeCleaned(task.current_attempt_id);
  const sql=new Database(config.databasePath);
  sql.prepare("UPDATE tasks SET stop_state='stopped',state='waiting' WHERE task_id=?").run(task.task_id);
  const successor=db.tasks.replaceStopped(task.task_id,config.jobResultsDir)!;
  assert.notEqual(successor.job_id,task.current_attempt_id);
  sql.prepare("UPDATE jobs SET status='completed',result_json=? WHERE job_id=?").run(JSON.stringify({job_id:task.current_attempt_id,status:'completed',summary:'<script>visible plain text</script>',completed_at:new Date().toISOString(),output:{format:'markdown',text:'完了内容'},secret_path:'/private/hidden',artifacts:[{display_name:'報告',kind:'report',path:'/private/artifact'}]}),task.current_attempt_id);sql.close();
  reader=new DashboardTaskReader(config.databasePath);
  assert.equal(reader.snapshot(task.task_id,foreign.current_attempt_id),null);
  const content:ConversationContent={name:db.getJob(task.current_attempt_id)!.agent_name,generation:'generation',thread_id:'thread',role:'worker',attempt_id:task.current_attempt_id,connected:false,observed_at:new Date().toISOString(),state:'unknown',items:[],events:[],cursor:0,oldest_sequence:0,gap:true,truncated:true};
  const observer=new DashboardObserver(reader,{async conversations(){throw Error('inventory must not be required');},async conversation(){return content;}});
  const authority=()=>({revision:'1',task:()=>true,conversation:()=>true});
  const detail=await observer.detail(task.task_id,authority,undefined,task.current_attempt_id);
  assert.equal(detail!.runtime.status,'observed');assert.equal(detail!.snapshot.selected_attempt_id,task.current_attempt_id);assert.equal(detail!.snapshot.task.current_attempt_id,successor.job_id);assert.equal(detail!.snapshot.attempts.length,2);
  assert.equal(detail!.snapshot.result?.summary,'<script>visible plain text</script>');assert.equal(detail!.snapshot.result?.output,'完了内容');assert.equal(JSON.stringify(detail).includes('/private/'),false);
  assert.equal((await observer.detail(task.task_id,()=>({...authority(),conversation:()=>false})))!.snapshot.result,null);
 }finally{reader?.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});

test('Dona本体の履歴は別grantを要求しrole/threadの一致とI/O中失効を検証する',async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),reader=new DashboardTaskReader(config.databasePath);
 try {
  const main:ConversationContent={name:'dona_main',generation:'current',role:'main',thread_id:'thread',attempt_id:null,connected:true,observed_at:new Date().toISOString(),state:'working',items:[{id:'item',turn_id:'turn',kind:'assistant_message',text:'main visible'}],events:[],cursor:0,oldest_sequence:0,gap:false,truncated:false};
  let grant=false,change=()=>{};
  const auth=()=>({revision:'1',task:()=>true,conversation:()=>true,mainConversation:()=>grant});
  const observer=new DashboardObserver(reader,{async conversations(){return{items:[main],next:null};},async conversationHistory(){return{items:[{...main,generation:'old',recorded_at:main.observed_at}],next:null};},async conversation(_name,generation){change();return{...main,generation};}});
  assert.equal(await observer.mainList(auth),null);grant=true;
  assert.deepEqual((await observer.mainList(auth))!.items.map(row=>row.generation),['current','old']);
  assert.equal((await observer.mainDetail('dona_main','old',auth))!.status,'observed');
  const {projectItem}=await import('../src/app-server/observation.js');
  main.items=[projectItem({id:'command',type:'commandExecution',command:'npm test',aggregatedOutput:'3 tests passed',exitCode:0,durationMs:123,status:'completed'},'turn')!,
    projectItem({id:'request',type:'userMessage',content:[{type:'text',text:'テストを実行して'}]},'turn')!,
    projectItem({id:'private-output',type:'commandExecution',aggregatedOutput:'3 tests passed\nAuthorization: Bearer hidden_token'},'turn')!];
  const details=await observer.mainDetail('dona_main','current',auth);
  assert.ok(details);
  assert.equal(details.status,'observed');
  if(details.status==='observed'){
    assert.equal(details.conversation.items[0]!.command,'npm test');
    assert.equal(details.conversation.items[0]!.duration_ms,123);
    assert.match(details.conversation.items[0]!.output!,/3 tests passed/);
    assert.equal(details.conversation.items[1]!.text,'テストを実行して');
    assert.equal(details.conversation.items[2]!.output,'3 tests passed\nAuthorization: Bearer hidden_token');
    assert.equal(JSON.stringify(details).includes('hidden_token'),true);
  }

  assert.equal((await observer.mainDetail('other','old',auth))!.status,'unavailable');
  change=()=>{grant=false;};assert.equal(await observer.mainDetail('dona_main','old',auth),null);
 }finally{reader.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});

test('通常操作UIのowner hintはsource名でなく現在Attemptの永続owner bindingから作る',async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);let reader:DashboardTaskReader|undefined;
 try{
  const event=db.enqueue(eventEnvelope('observer-owner-hint')).row;
  const slack=db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:'slack-owned',objective:'fixture',workspace:{kind:'scratch'}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
  const local=db.createLocalDashboardTask({instance_id:'instance',owner_id:'operator',device_id:'device',grant_revision:1},{request_id:'local-hint',objective:'fixture',workspace:{kind:'scratch'}},config.jobsWorkspaceRoot,config.jobResultsDir).task;
  reader=new DashboardTaskReader(config.databasePath);
  assert.equal(reader.snapshot(slack.task_id)!.task.local_operator_owned,false);assert.equal(reader.snapshot(local.task_id)!.task.local_operator_owned,true);
  const list=reader.list(()=>true);assert.equal(list.items.find(row=>row.task_id===slack.task_id)!.local_operator_owned,false);assert.equal(list.items.find(row=>row.task_id===local.task_id)!.local_operator_owned,true);
  const {default:Database}=await import('better-sqlite3'),sql=new Database(config.databasePath);
  sql.prepare("UPDATE jobs SET source='web' WHERE job_id=?").run(slack.current_attempt_id);sql.close();
  assert.equal(reader.snapshot(slack.task_id)!.task.local_operator_owned,false);
  assert.equal(JSON.stringify(reader.snapshot(local.task_id)).includes('owner_json'),false);
 }finally{reader?.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});


test('本体詳細は一覧と履歴で消費した時間を会話取得の期限へ引き継ぐ',async t=>{
 const main:ConversationContent={name:'dona_main',generation:'current',role:'main',thread_id:'thread',attempt_id:null,connected:true,observed_at:new Date().toISOString(),state:'working',items:[],events:[],cursor:0,oldest_sequence:0,gap:false,truncated:false};
 let now=0,reads=0;
 t.mock.method(performance,'now',()=>now);
 t.mock.timers.enable({apis:['setTimeout']});
 let begun!:()=>void;
 const conversationStarted=new Promise<void>(resolve=>{begun=resolve;});
 const observer=new DashboardObserver(null as unknown as DashboardTaskReader,{
  async conversations(){reads++;now+=2000;return{items:[main],next:null};},
  async conversationHistory(){reads++;now+=2500;return{items:[],next:null};},
  async conversation(){reads++;begun();return new Promise<ConversationContent>(()=>{});},
 });
 const auth=()=>({revision:'1',task:()=>false,conversation:()=>false,mainConversation:()=>true});
 assert.equal(await observer.mainDetail('dona_main','current',()=>null),null);
 assert.equal(reads,0);
 let settled=false;
 const detail=observer.mainDetail('dona_main','current',auth).then(result=>{settled=true;return result;});
 await conversationStarted;
 now=4999;t.mock.timers.tick(499);await Promise.resolve();await Promise.resolve();
 assert.equal(settled,false);
 now=5000;t.mock.timers.tick(1);
 for(let i=0;i<6;i++)await Promise.resolve();
 assert.equal(settled,true,'一覧取得後に新たな5秒期限を開始しない');
 assert.deepEqual(await detail,{status:'unavailable'});
 assert.equal(reads,3);
});


test('現在の依頼はTask steerを表示し未受理を明示、過去Attemptは当時の依頼を維持する',async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath);
 const {default:Database}=await import('better-sqlite3'),sql=new Database(config.databasePath);
 const reader=new DashboardTaskReader(config.databasePath);
 try{
  const event=db.enqueue(eventEnvelope('observer-effective-request')).row;
  const task=db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:'effective-request',objective:'当初の依頼',workspace:{kind:'scratch'}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
  const observer=new DashboardObserver(reader,{async conversations(){throw Error('unused');},async conversation(){throw Error('unused');}});
  const grant=()=>({revision:'1',task:()=>true,conversation:()=>true});
  const hidden=()=>({...grant(),conversation:()=>false});
  sql.prepare("UPDATE jobs SET status='running' WHERE job_id=?").run(task.current_attempt_id);
  const follow=db.enqueue(eventEnvelope('observer-steer')).row;
  db.tasks.prepareSteer(task.task_id,follow.event_id,task.revision,'追加の確認');
  const pending=reader.snapshot(task.task_id)!;
  assert.match(pending.request!,/^追加指示のワーカー受理は未確認です。/);
  assert.match(pending.request!,/当初の依頼/);assert.match(pending.request!,/追加の確認/);
  assert.equal(db.getJob(task.current_attempt_id)!.objective,'当初の依頼');
  const hiddenBefore=await observer.detail(task.task_id,hidden);
  const visiblePending=await observer.detail(task.task_id,grant);assert.ok(visiblePending);
  // An accepted receipt for an older/different event cannot clear this notice.
  sql.prepare("UPDATE jobs SET steer_state='accepted',steer_event_id=? WHERE job_id=?").run(event.event_id,task.current_attempt_id);
  assert.equal(reader.snapshot(task.task_id)!.request,pending.request);
  sql.prepare("UPDATE jobs SET steer_event_id=? WHERE job_id=?").run(follow.event_id,task.current_attempt_id);
  const accepted=reader.snapshot(task.task_id)!;
  assert.doesNotMatch(accepted.request!,/受理は未確認/);assert.match(accepted.request!,/追加の確認/);
  assert.equal(accepted.fingerprint,pending.fingerprint,'receipt/request content is not added to public hash');
  assert.deepEqual(await observer.detail(task.task_id,hidden),hiddenBefore);
  const {OperatorStream}=await import('../src/dashboard/operator-stream.js');
  const stream=new OperatorStream(),scope=stream.scope('authority','task');
  const cursor=stream.snapshot(scope,visiblePending).stream_cursor;
  const value=await observer.detail(task.task_id,grant);assert.ok(value);
  assert.match(stream.frame(scope,value,stream.read(cursor,scope)),/event: snapshot/);
  db.tasks.finishSteer(task.task_id,follow.event_id);
  assert.equal(reader.snapshot(task.task_id)!.request,accepted.request);
  // A later unresolved steer keeps already accepted instructions visible.
  const next=db.enqueue(eventEnvelope('observer-steer-next')).row,current=db.tasks.get(task.task_id)!;
  db.tasks.prepareSteer(task.task_id,next.event_id,current.revision,'次の追加');
  assert.match(reader.snapshot(task.task_id)!.request!,/追加の確認/);
  assert.match(reader.snapshot(task.task_id)!.request!,/^追加指示のワーカー受理は未確認/);
  sql.prepare("UPDATE tasks SET stop_state='stopped',state='waiting' WHERE task_id=?").run(task.task_id);
  const successor=db.tasks.replaceStopped(task.task_id,config.jobResultsDir)!;assert.ok(successor);
  assert.equal(reader.snapshot(task.task_id,task.current_attempt_id)!.request,'当初の依頼');
  assert.match(reader.snapshot(task.task_id)!.request!,/次の追加/);
 }finally{reader.close();sql.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});
