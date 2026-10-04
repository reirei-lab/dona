import fs from "node:fs";
import Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {RuntimeStore,type AgentRecord} from "./store.js";
import {processes,same,type ProcessIdentity} from "./process.js";

interface StopReceipt {processes:ProcessIdentity[];launch_agents:string[];herdr_session:string;verified_at:string;}
/** 外部保守runnerだけが全writer停止後に呼ぶ。既存Task/Result/権限は変更しない。 */
export function migrateStoppedRuntime(dispatcherFile:string,runtimeFile:string,receipt:StopReceipt,release:string):void {
 if(receipt.herdr_session!=="dona"||!["dev.dona.dispatcher","dev.dona.updater","dev.dona.slack-adapter"].every(label=>receipt.launch_agents.includes(label))||!Array.isArray(receipt.processes))throw Error("runtime_migration_stop_receipt_invalid");
 const sample=processes();
 if(receipt.processes.some(p=>{const live=sample.find(x=>x.pid===p.pid);return p.uid!==process.getuid?.()||(same(p,live)&&!live!.state.includes("Z"));}))throw Error("runtime_migration_process_still_alive");
 const source=new Database(dispatcherFile,{readonly:true,fileMustExist:true}),store=new RuntimeStore(runtimeFile);
 try {
  store.db.exec("CREATE TABLE IF NOT EXISTS stops(agent TEXT PRIMARY KEY,generation TEXT NOT NULL,processes_json TEXT NOT NULL,state TEXT NOT NULL)");
  store.db.transaction(()=>{
   if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='host_owner'").get()) {
    const owner=store.db.prepare("SELECT identity_json FROM host_owner WHERE singleton=1").get() as {identity_json:string}|undefined;
    if(owner){const old=JSON.parse(owner.identity_json) as ProcessIdentity;if(!receipt.processes.some(p=>same(p,old))&&sample.some(p=>same(p,old)&&!p.state.includes("Z")))throw Error("runtime_migration_host_stop_missing");}
    store.db.prepare("DELETE FROM host_owner").run();
   }
   if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='main_recoveries'").get())store.db.prepare("DELETE FROM main_recoveries").run();
   // 古いApp Server要求は旧stdio接続に束縛されている。新接続へ回答を移植しない。
   store.db.prepare("UPDATE questions SET state='expired' WHERE state IN ('pending','answering')").run();
   for(const agent of store.agents()) {
    if(agent.state==="stopped")continue;
    // rootの消失だけでは子の停止証明にならない。detached App Serverの
    // process groupも残っていないことを、全writer停止後のsampleで確認する。
    if(!agent.pid||!agent.process_start||sample.some(p=>!p.state.includes("Z")&&((p.pid===agent.pid&&p.start===agent.process_start)||p.group===agent.pid)))throw Error("runtime_migration_agent_stop_missing");
    store.db.prepare("INSERT INTO stops VALUES(?,?,?,'stopped') ON CONFLICT(agent) DO UPDATE SET generation=excluded.generation,processes_json=excluded.processes_json,state='stopped'").run(agent.name,agent.generation,JSON.stringify(receipt.processes));
    store.change(agent.name,agent.generation,{state:"stopped",turn_id:null});
   }
   const rows=source.prepare(`SELECT j.*,i.herdr_agent_session_id FROM jobs j LEFT JOIN job_live_session_identities i USING(job_id)
     WHERE j.herdr_workspace_id IS NOT NULL AND j.herdr_pane_id IS NOT NULL`).all() as Array<{agent_name:string;workspace_path:string;herdr_workspace_id:string;herdr_pane_id:string;herdr_agent_session_id:string|null}>;
   for(const job of rows) {
    if(store.agent(job.agent_name))continue;
    const root=receipt.processes[0];
    const row:AgentRecord={name:job.agent_name,generation:randomUUID(),role:"worker",cwd:job.workspace_path,release,thread_id:job.herdr_agent_session_id,turn_id:null,pid:root?.pid??null,process_start:root?.start??null,state:"stopped",request_hash:"legacy-stopped",
     config_json:JSON.stringify({legacyWorkspaceId:job.herdr_workspace_id,legacyPaneId:job.herdr_pane_id,processGroups:[...new Set(receipt.processes.map(p=>p.group).filter(Number.isSafeInteger))]}),sequence:0};
    store.put(row);store.db.prepare("INSERT INTO stops VALUES(?,?,?,'stopped')").run(row.name,row.generation,JSON.stringify(receipt.processes));
   }
  }).immediate();
 }finally{source.close();store.close();}
 fs.chmodSync(runtimeFile,0o600);
}
