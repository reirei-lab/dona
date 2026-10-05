import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface AgentRecord {
  name:string; generation:string; role:"main"|"worker"; cwd:string; release:string;
  thread_id:string|null; turn_id:string|null; pid:number|null; process_start:string|null;
  state:"starting"|"idle"|"working"|"waiting"|"interrupted"|"unknown"|"stopped";
  request_hash:string; config_json:string; sequence:number;
  startup_ready?:boolean;
  recovery_hint?:{reason:"capacity_wait"|"authorization_required"|"configuration_error";retry_after?:string};
}
export interface QuestionRecord {
  question_id:string; agent:string; generation:string; thread_id:string; turn_id:string;
  rpc_id_json:string; kind:"question"|"approval"|"elicitation";
  payload_json:string; state:"pending"|"answering"|"resolved"|"expired";
  answer_hash:string|null; created_at:string;
}

export class RuntimeStore {
  readonly db:Database.Database;
  constructor(file:string) {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error("runtime_database_symlink");
    this.db=new Database(file);fs.chmodSync(file,0o600);
    this.db.pragma("journal_mode=WAL");this.db.pragma("synchronous=FULL");this.db.pragma("busy_timeout=5000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS agents(
      name TEXT PRIMARY KEY,generation TEXT NOT NULL,role TEXT NOT NULL,cwd TEXT NOT NULL,release TEXT NOT NULL,
      thread_id TEXT,turn_id TEXT,pid INTEGER,process_start TEXT,state TEXT NOT NULL,
      request_hash TEXT NOT NULL,config_json TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS questions(
      question_id TEXT PRIMARY KEY,agent TEXT NOT NULL,generation TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,
      rpc_id_json TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,
      answer_hash TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(
      agent TEXT NOT NULL,operation_key TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,
      PRIMARY KEY(agent,operation_key));`);
  }
  agent(name:string):AgentRecord|undefined {return this.db.prepare("SELECT * FROM agents WHERE name=?").get(name) as AgentRecord|undefined;}
  agents():AgentRecord[] {return this.db.prepare("SELECT * FROM agents ORDER BY name").all() as AgentRecord[];}
  put(agent:AgentRecord):void {
    this.db.prepare(`INSERT INTO agents VALUES(@name,@generation,@role,@cwd,@release,@thread_id,@turn_id,@pid,@process_start,@state,@request_hash,@config_json,@sequence)
      ON CONFLICT(name) DO UPDATE SET generation=excluded.generation,role=excluded.role,cwd=excluded.cwd,release=excluded.release,
      thread_id=excluded.thread_id,turn_id=excluded.turn_id,pid=excluded.pid,process_start=excluded.process_start,state=excluded.state,
      request_hash=excluded.request_hash,config_json=excluded.config_json,sequence=excluded.sequence`).run(agent);
  }
  change(name:string,generation:string,values:Partial<Pick<AgentRecord,"state"|"thread_id"|"turn_id">>):void {
    const row=this.agent(name);if(!row||row.generation!==generation)return;
    this.put({...row,...values,sequence:row.sequence+1});
  }
  question(id:string):QuestionRecord|undefined{return this.db.prepare("SELECT * FROM questions WHERE question_id=?").get(id) as QuestionRecord|undefined;}
  questions(name:string):QuestionRecord[]{return this.db.prepare("SELECT * FROM questions WHERE agent=? AND state IN ('pending','answering') ORDER BY created_at,question_id").all(name) as QuestionRecord[];}
  addQuestion(row:QuestionRecord):void{this.db.prepare("INSERT INTO questions VALUES(@question_id,@agent,@generation,@thread_id,@turn_id,@rpc_id_json,@kind,@payload_json,@state,@answer_hash,@created_at)").run(row);}
  close():void{this.db.close();}
}
