import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {test} from "node:test";
import Database from "better-sqlite3";
import {RuntimeStore,type AgentRecord} from "../src/app-server/store.js";
import {AppServerManager} from "../src/app-server/manager.js";
import {archiveRuntimeBinding,installRuntimeBindingArchive} from "../src/runtime-binding-archive.js";
import {isDispatcherCoreTrigger} from "../src/dispatcher-core-triggers.js";

const agent=(generation:string):AgentRecord=>({name:"worker",generation,role:"worker",cwd:"/fixture",release:"/fixture",thread_id:`thread-${generation}`,turn_id:null,pid:null,process_start:null,state:"stopped",request_hash:"hash",config_json:JSON.stringify({attemptId:`job-${generation}`}),sequence:0});

test("過去generationは再起動後も登録済みキャッシュだけを返しRPCを行わない",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dona-history-")),file=path.join(root,"runtime.db");let store=new RuntimeStore(file);
 try{
  store.put(agent("old"));store.cacheItem("worker","old",{id:"one",turn_id:"turn",kind:"assistant_message",text:"保存済み"});
  store.observe("worker","old",{kind:"turn/completed"});store.put(agent("new"));store.close();store=new RuntimeStore(file);
  let calls=0;const manager=new AppServerManager(store,()=>{calls++;throw Error("must_not_connect");});
  const result=await manager.conversation("worker","old",0);
  assert.equal(result.archived,true);assert.equal(result.connected,false);assert.equal(result.state,"unknown");
  assert.equal(result.attempt_id,"job-old");assert.equal(result.thread_id,"thread-old");assert.equal(result.items[0]?.text,"保存済み");assert.equal(result.gap,true);assert.equal(result.truncated,true);
  await assert.rejects(manager.conversation("worker","unregistered"),/not_current/);
  await assert.rejects(manager.conversation("personal","old"),/not_current/);
  assert.deepEqual(manager.conversationHistory("worker").items.map(r=>r.generation),["new","old"]);
  assert.equal(calls,0);
  assert.throws(()=>store.put({...agent("old"),thread_id:"swapped"}),/binding_conflict/);
  assert.equal(store.agent("worker")?.generation,"new");
  store.db.prepare("UPDATE observation_items SET observed_at='2000-01-01T00:00:00Z'").run();
  store.db.prepare("UPDATE observation_events SET observed_at='2000-01-01T00:00:00Z'").run();
  const expired=await manager.conversation("worker","old",0);assert.equal(expired.items.length,0);assert.equal(expired.events.length,0);assert.equal(expired.gap,true);assert.equal(calls,0);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("過去generationの履歴と通知は件数・bytesを超えず欠落を明示する",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dona-history-bound-")),store=new RuntimeStore(path.join(root,"runtime.db"));
 try{
  store.put(agent("old"));
  for(let i=0;i<1002;i++){
   store.cacheItem("worker","old",{id:String(i),turn_id:"turn",kind:"assistant_message",text:"あ".repeat(8192)});
   store.observe("worker","old",{kind:"item/agentMessage/delta",text:"a".repeat(512)});
  }
  store.put(agent("new"));const manager=new AppServerManager(store,()=>{throw Error("must_not_connect");});
  const result=await manager.conversation("worker","old",0);
  assert.ok(result.items.length<=200);assert.ok(result.events.length<=1000);assert.ok(Buffer.byteLength(JSON.stringify(result))<800_000);assert.equal(result.gap,true);assert.equal(result.truncated,true);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});

test("Dispatcher binding移行はHerdrを捏造せずappend-onlyで世代差替えを拒否する",()=>{
 const db=new Database(":memory:");
 try{
  db.exec(`CREATE TABLE job_live_session_identities(job_id TEXT,agent_name TEXT,herdr_agent_session_id TEXT,recorded_at TEXT);
   CREATE TABLE task_attempts(attempt_id TEXT,task_id TEXT);
   INSERT INTO task_attempts VALUES('job','task');
   INSERT INTO job_live_session_identities VALUES('job','worker','["gen","thread"]','2026-10-05T00:00:00Z'),('legacy','herdr','old-session','2026-10-05T00:00:00Z');`);
  installRuntimeBindingArchive(db);const rows=db.prepare("SELECT * FROM job_runtime_bindings").all() as {task_id:string}[];assert.equal(rows.length,1);assert.equal(rows[0]?.task_id,"task");
  installRuntimeBindingArchive(db);assert.equal((db.prepare("SELECT count(*) AS n FROM job_runtime_bindings").get() as {n:number}).n,1);
  const live=db.prepare("SELECT * FROM job_live_session_identities WHERE job_id='job'").get() as Parameters<typeof archiveRuntimeBinding>[1];
  assert.throws(()=>archiveRuntimeBinding(db,{...live!,herdr_agent_session_id:'["gen","different"]'}),/binding_conflict/);
  db.exec("DELETE FROM job_live_session_identities");assert.equal((db.prepare("SELECT count(*) AS n FROM job_runtime_bindings").get() as {n:number}).n,1);
  assert.throws(()=>db.exec("UPDATE job_runtime_bindings SET thread_id='changed'"),/append_only/);
  assert.throws(()=>db.exec("DELETE FROM job_runtime_bindings"),/append_only/);
  const triggers=db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'").all() as {name:string;tbl_name:string;sql:string}[];
  assert.ok(triggers.every(isDispatcherCoreTrigger));
 }finally{db.close();}
});

test("main世代一覧はDona登録済みbindingだけを100件ずつ返す",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"dona-main-history-")),store=new RuntimeStore(path.join(root,"runtime.db"));
 try{
  for(let i=0;i<105;i++)store.put({...agent(`g${String(i).padStart(3,"0")}`),name:"main",role:"main",config_json:"{}"});
  const manager=new AppServerManager(store,()=>{throw Error("must_not_connect");});
  const first=manager.conversationHistory("main"),second=manager.conversationHistory("main",first.next!);
  assert.equal(first.items.length,100);assert.equal(second.items.length,5);assert.equal(second.next,null);
  assert.equal(new Set([...first.items,...second.items].map(row=>row.generation)).size,105);
  assert.ok(first.items.every(row=>row.role==="main"&&row.attempt_id===null));
  assert.deepEqual(manager.conversationHistory("personal"),{items:[],next:null});
  assert.throws(()=>store.db.exec("DELETE FROM conversation_bindings"),/immutable/);
 }finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
});
