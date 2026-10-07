import type Database from "better-sqlite3";
import type {LiveSessionIdentityRow} from "./live-session.js";

export interface JobRuntimeBinding {
  job_id:string; task_id:string|null; agent_name:string; generation:string; thread_id:string; recorded_at:string;
}
export const runtimeBindingTriggers = ["UPDATE", "DELETE"].map(operation => ({
  name:`job_runtime_bindings_no_${operation.toLowerCase()}`,tbl_name:"job_runtime_bindings",
  sql:`CREATE TRIGGER job_runtime_bindings_no_${operation.toLowerCase()} BEFORE ${operation} ON job_runtime_bindings BEGIN SELECT RAISE(ABORT,'runtime_binding_append_only'); END`,
}));
export function installRuntimeBindingArchive(db:Database.Database):void {
  db.transaction(()=>{
    db.exec(`CREATE TABLE IF NOT EXISTS job_runtime_bindings(
      job_id TEXT NOT NULL,task_id TEXT,agent_name TEXT NOT NULL,generation TEXT NOT NULL,
      thread_id TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(job_id,generation));`);
    for(const trigger of runtimeBindingTriggers) db.exec(trigger.sql.replace("CREATE TRIGGER ","CREATE TRIGGER IF NOT EXISTS "));
    let after="";
    for(;;){
      const rows=db.prepare("SELECT * FROM job_live_session_identities WHERE job_id>? ORDER BY job_id LIMIT 100").all(after) as LiveSessionIdentityRow[];
      for(const row of rows)archiveRuntimeBinding(db,row);
      if(rows.length<100)break;after=rows.at(-1)!.job_id;
    }
  }).immediate();
}
export function archiveRuntimeBinding(db:Database.Database,row:LiveSessionIdentityRow|undefined):void {
  if(!row?.agent_name)return;
  let identity:unknown;try{identity=JSON.parse(row.herdr_agent_session_id);}catch{return;}
  // 旧Herdr session IDからApp Serverのgeneration/threadを推定しない。
  if(!Array.isArray(identity)||identity.length!==2||!identity.every(x=>typeof x==="string"&&/^[A-Za-z0-9_-]{1,160}$/.test(x)))return;
  const [generation,thread_id]=identity as [string,string];
  const task=db.prepare("SELECT task_id FROM task_attempts WHERE attempt_id=?").get(row.job_id) as {task_id:string}|undefined;
  const binding:JobRuntimeBinding={job_id:row.job_id,task_id:task?.task_id??null,agent_name:row.agent_name,generation,thread_id,recorded_at:row.recorded_at};
  const existing=db.prepare("SELECT * FROM job_runtime_bindings WHERE job_id=? AND generation=?").get(row.job_id,generation) as JobRuntimeBinding|undefined;
  if(existing){if(existing.agent_name!==binding.agent_name||existing.thread_id!==thread_id||existing.task_id!==binding.task_id)throw Error("runtime_binding_conflict");return;}
  db.prepare("INSERT INTO job_runtime_bindings VALUES(@job_id,@task_id,@agent_name,@generation,@thread_id,@recorded_at)").run(binding);
}
