import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import Database from "better-sqlite3";
import {serveRuntime} from "../src/app-server/host.js";
import {AppServerAgentClient} from "../src/app-server/adapters.js";
import {RuntimeClient} from "../src/app-server/client.js";
import {migrateStoppedRuntime} from "../src/app-server/migration.js";
import {RuntimeStore} from "../src/app-server/store.js";
import {identity} from "../src/app-server/process.js";

test("hostの二重起動を拒否し、既存socketと所有権を壊さない",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-host-"));
 const config={socket:path.join(root,"runtime.sock"),database:path.join(root,"runtime.db"),codex:process.execPath,buildSha:"test"};
 const server=await serveRuntime(config);
 try{
  await assert.rejects(serveRuntime(config),/already_running/);
  assert.deepEqual(await new RuntimeClient(config.socket).list(),[]);
  const prompted=await new AppServerAgentClient(config.socket,"dona-main",100).submit("未送信","event");
  assert.equal(prompted.ok,false);assert.equal(prompted.errorCode,"agent_not_running");
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await fs.rm(root,{recursive:true,force:true});}
});

test("停止済み旧workerを移行し、Taskと成果物のDBを変更しない",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-runtime-migration-"));
 const file=path.join(root,"dona.db"),runtime=path.join(root,"runtime.db"),db=new Database(file);
 db.exec("CREATE TABLE jobs(job_id TEXT, agent_name TEXT, workspace_path TEXT, herdr_workspace_id TEXT, herdr_pane_id TEXT); CREATE TABLE job_live_session_identities(job_id TEXT,herdr_agent_session_id TEXT); CREATE TABLE tasks(task_id TEXT,current_attempt_id TEXT)");
 db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?)").run("job","worker",root,"wC4","wC4:p1");db.prepare("INSERT INTO tasks VALUES(?,?)").run("task","job");db.close();
 const before=await fs.readFile(file),live=identity(process.pid)!;
 const receipt={processes:[{...live,start:"old-generation"}],launch_agents:["dev.dona.dispatcher","dev.dona.updater","dev.dona.slack-adapter"],herdr_session:"dona",verified_at:new Date().toISOString()};
 try{
  assert.throws(()=>migrateStoppedRuntime(file,runtime,{...receipt,processes:[live]},root),/still_alive/);
  migrateStoppedRuntime(file,runtime,receipt,root);
  const store=new RuntimeStore(runtime);
  try{const agent=store.agent("worker")!;assert.equal(agent.state,"stopped");assert.equal(JSON.parse(agent.config_json).legacyPaneId,"wC4:p1");assert.equal((store.db.prepare("SELECT state FROM stops WHERE agent='worker'").get() as {state:string}).state,"stopped");}finally{store.close();}
  assert.deepEqual(await fs.readFile(file),before);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});


test("unknownの観測は失敗として返し監視の即時再選択を防ぐ",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-observe-")),database=path.join(root,"runtime.db"),socket=path.join(root,"runtime.sock");
 const store=new RuntimeStore(database);
 store.put({name:"worker",generation:"g",role:"worker",cwd:root,release:root,thread_id:"t",turn_id:"turn",pid:2147483647,process_start:"gone",state:"working",request_hash:"h",config_json:"{}",sequence:0});store.close();
 const host=await serveRuntime({socket,database,codex:process.execPath,buildSha:"test"});
 try{const client=new AppServerAgentClient(socket,"worker",100);for(const result of [await client.get(),await client.wait()]){assert.equal(result.ok,false);assert.equal(result.errorCode,"runtime_observation_unknown");}}
 finally{await new Promise<void>(resolve=>host.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
});

test("移行前にcrashしたrootはprocess groupも不在なら移行し、子が残る場合は拒否する",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-crashed-migration-")),file=path.join(root,"dona.db"),runtime=path.join(root,"runtime.db");
 const db=new Database(file);db.exec("CREATE TABLE jobs(job_id TEXT,agent_name TEXT,workspace_path TEXT,herdr_workspace_id TEXT,herdr_pane_id TEXT);CREATE TABLE job_live_session_identities(job_id TEXT,herdr_agent_session_id TEXT)");db.close();
 const live=identity(process.pid)!,store=new RuntimeStore(runtime);
 store.put({name:"crashed",generation:"g",role:"worker",cwd:root,release:root,thread_id:"t",turn_id:null,pid:live.group,process_start:"gone",state:"unknown",request_hash:"h",config_json:"{}",sequence:0});store.close();
 const receipt={processes:[{...live,start:"old"}],launch_agents:["dev.dona.dispatcher","dev.dona.updater","dev.dona.slack-adapter"],herdr_session:"dona",verified_at:new Date().toISOString()};
 try{
  assert.throws(()=>migrateStoppedRuntime(file,runtime,{...receipt,processes:[]},root),/agent_stop_missing/);
  const before=new RuntimeStore(runtime);const agent=before.agent("crashed")!;before.put({...agent,pid:2147483647});before.close();
  migrateStoppedRuntime(file,runtime,{...receipt,processes:[]},root);
  const after=new RuntimeStore(runtime);try{assert.equal(after.agent("crashed")?.state,"stopped");}finally{after.close();}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("全processが停止済みなら空のreceiptで旧worker履歴を保持して移行できる",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-empty-migration-")),file=path.join(root,"dona.db"),runtime=path.join(root,"runtime.db");
 const db=new Database(file);db.exec("CREATE TABLE jobs(job_id TEXT,agent_name TEXT,workspace_path TEXT,herdr_workspace_id TEXT,herdr_pane_id TEXT);CREATE TABLE job_live_session_identities(job_id TEXT,herdr_agent_session_id TEXT)");db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?)").run("job","worker",root,"old","pane");db.close();
 try{
  migrateStoppedRuntime(file,runtime,{processes:[],launch_agents:["dev.dona.dispatcher","dev.dona.updater","dev.dona.slack-adapter"],herdr_session:"dona",verified_at:new Date().toISOString()},root);
  const store=new RuntimeStore(runtime);try{const row=store.agent("worker")!;assert.equal(row.state,"stopped");assert.equal(row.pid,null);assert.equal((store.db.prepare("SELECT processes_json FROM stops").get() as {processes_json:string}).processes_json,"[]");}finally{store.close();}
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("100件の解決済み履歴があっても古い未回答・回答中の要求を取得できる",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-question-history-")),database=path.join(root,"runtime.db"),socket=path.join(root,"runtime.sock");
 const host=await serveRuntime({socket,database,codex:process.execPath,buildSha:"test"}),store=new RuntimeStore(database);
 try{
  store.put({name:"worker",generation:"g",role:"worker",cwd:root,release:root,thread_id:"t",turn_id:null,pid:null,process_start:null,state:"stopped",request_hash:"h",config_json:"{}",sequence:0});
  for(let i=0;i<105;i++)store.addQuestion({question_id:`q-${i}`,agent:"worker",generation:i===104?"old":"g",thread_id:"t",turn_id:"turn",rpc_id_json:String(i),kind:i===0?"approval":"question",payload_json:"{}",state:i===0?"pending":i===1?"answering":"resolved",answer_hash:null,created_at:new Date(i*1000).toISOString()});
  const rows=await new RuntimeClient(socket).questions("worker",true);
  assert.equal(rows.length,102);assert.ok(rows.some(q=>q.question_id==="q-0"));assert.ok(rows.some(q=>q.question_id==="q-1"));assert.ok(!rows.some(q=>q.question_id==="q-104"));
 }finally{store.close();await new Promise<void>(resolve=>host.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
});

test("global pendingをcursorで巡回し、通知済み100件の後にも到達する",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"dona-question-pages-")),database=path.join(root,"runtime.db"),socket=path.join(root,"runtime.sock");
 const host=await serveRuntime({socket,database,codex:process.execPath,buildSha:"test"}),store=new RuntimeStore(database);
 try{
  store.put({name:"worker",generation:"g",role:"worker",cwd:root,release:root,thread_id:"t",turn_id:null,pid:null,process_start:null,state:"stopped",request_hash:"h",config_json:"{}",sequence:0});
  for(let i=0;i<105;i++)store.addQuestion({question_id:`q-${String(i).padStart(3,"0")}`,agent:"worker",generation:"g",thread_id:"t",turn_id:"turn",rpc_id_json:String(i),kind:"question",payload_json:"{}",state:"pending",answer_hash:null,created_at:new Date(i*1000).toISOString()});
  const client=new RuntimeClient(socket),seen=new Set<string>();let after:string|undefined;
  for(let i=0;i<7;i++){
   const page=await client.call<Array<{question_id:string}>>("pendingQuestions",{after});assert.ok(page.length<=20);
   for(const q of page)seen.add(q.question_id);after=page.at(-1)?.question_id;
  }
  assert.equal(seen.size,105);assert.equal(after,undefined);
  assert.equal((await client.call<Array<{question_id:string}>>("pendingQuestions",{after}))[0]!.question_id,"q-000");
 }finally{store.close();await new Promise<void>(resolve=>host.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
});
