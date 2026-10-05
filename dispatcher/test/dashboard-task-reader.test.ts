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
    assert.equal(JSON.stringify(snapshot).includes("secret objective"),false);
    assert.equal(JSON.stringify(snapshot).includes(config.jobsWorkspaceRoot),false);
    assert.deepEqual(ids.map(id=>db.tasks.get(id)),before);
    assert.throws(()=>reader!.list(()=>true,null,51),/query_invalid/);
    assert.equal(reader.snapshot("unknown"),null);
    assert.throws(()=>new DashboardTaskReader(`${root}/absent.sqlite3`));
  } finally { reader?.close();db.close();await fs.rm(root,{recursive:true,force:true}); }
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
    assert.equal((await observer.detail(task.task_id,()=>authority))!.runtime.status,"forbidden");
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
  assert.equal((await observer.mainDetail('other','old',auth))!.status,'unavailable');
  change=()=>{grant=false;};assert.equal(await observer.mainDetail('dona_main','old',auth),null);
 }finally{reader.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});
