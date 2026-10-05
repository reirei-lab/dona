import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {sanitizeConversationItem,type ObservationEvent,type ConversationItem} from "./observation.js";

export interface AgentRecord {
  name:string; generation:string; role:"main"|"worker"; cwd:string; release:string;
  thread_id:string|null; turn_id:string|null; pid:number|null; process_start:string|null;
  state:"starting"|"idle"|"working"|"waiting"|"interrupted"|"unknown"|"stopped";
  request_hash:string; config_json:string; sequence:number;
  startup_ready?:boolean;
  startup_state?:"not_sent"|"sending"|"ready";
  recovery_hint?:{reason:"capacity_wait"|"authorization_required"|"configuration_error";retry_after?:string};
}
export interface ArchivedConversation {name:string;generation:string;role:"main"|"worker";thread_id:string;attempt_id:string|null;recorded_at:string}
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS observation_item_sequence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO observation_item_sequence VALUES(1,0);
      CREATE TABLE IF NOT EXISTS agents(
      name TEXT PRIMARY KEY,generation TEXT NOT NULL,role TEXT NOT NULL,cwd TEXT NOT NULL,release TEXT NOT NULL,
      thread_id TEXT,turn_id TEXT,pid INTEGER,process_start TEXT,state TEXT NOT NULL,
      request_hash TEXT NOT NULL,config_json TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS questions(
      question_id TEXT PRIMARY KEY,agent TEXT NOT NULL,generation TEXT NOT NULL,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,
      rpc_id_json TEXT NOT NULL,kind TEXT NOT NULL,payload_json TEXT NOT NULL,state TEXT NOT NULL,
      answer_hash TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(
      agent TEXT NOT NULL,operation_key TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,
      PRIMARY KEY(agent,operation_key));
      CREATE TABLE IF NOT EXISTS observation_items(agent TEXT NOT NULL,generation TEXT NOT NULL,item_id TEXT NOT NULL,item_json TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(agent,generation,item_id));
      CREATE TABLE IF NOT EXISTS observation_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,agent TEXT NOT NULL,generation TEXT NOT NULL,observed_at TEXT NOT NULL,event_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS observation_scope ON observation_events(agent,generation,sequence);
      CREATE INDEX IF NOT EXISTS observation_expiry ON observation_events(observed_at);
      CREATE TABLE IF NOT EXISTS observation_cursors(agent TEXT NOT NULL,generation TEXT NOT NULL,last_sequence INTEGER NOT NULL DEFAULT 0,discarded_through INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(agent,generation));`);
    if(!(this.db.prepare("PRAGMA table_info(observation_items)").all() as {name:string}[]).some(c=>c.name==="sequence")){
      this.db.exec("ALTER TABLE observation_items ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0");
      this.db.prepare("UPDATE observation_items SET sequence=rowid").run();
      this.db.prepare("UPDATE observation_item_sequence SET sequence=COALESCE((SELECT MAX(sequence) FROM observation_items),0)").run();
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversation_bindings(name TEXT NOT NULL,generation TEXT NOT NULL,
      role TEXT NOT NULL,thread_id TEXT NOT NULL,attempt_id TEXT,recorded_at TEXT NOT NULL,PRIMARY KEY(name,generation));
      CREATE TRIGGER IF NOT EXISTS conversation_bindings_no_update BEFORE UPDATE ON conversation_bindings BEGIN SELECT RAISE(ABORT,'conversation_binding_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS conversation_bindings_no_delete BEFORE DELETE ON conversation_bindings BEGIN SELECT RAISE(ABORT,'conversation_binding_immutable'); END;`);
    this.db.transaction(()=>{for(const row of this.agents())this.archiveConversation(row);}).immediate();
    this.expireObservations();
  }
  agent(name:string):AgentRecord|undefined {return this.db.prepare("SELECT * FROM agents WHERE name=?").get(name) as AgentRecord|undefined;}
  agents():AgentRecord[] {return this.db.prepare("SELECT * FROM agents ORDER BY name").all() as AgentRecord[];}
  private archiveConversation(agent:AgentRecord):void {
    if(!agent.thread_id)return;
    const input=JSON.parse(agent.config_json) as {attemptId?:string};
    const archived=this.archivedConversation(agent.name,agent.generation);
    if(archived){if(archived.thread_id!==agent.thread_id||archived.role!==agent.role||archived.attempt_id!==(input.attemptId??null))throw Error("runtime_conversation_binding_conflict");return;}
    this.db.prepare("INSERT INTO conversation_bindings VALUES(?,?,?,?,?,?)").run(agent.name,agent.generation,agent.role,agent.thread_id,input.attemptId??null,new Date().toISOString());
  }
  archivedConversation(name:string,generation:string):ArchivedConversation|undefined {
    return this.db.prepare("SELECT * FROM conversation_bindings WHERE name=? AND generation=?").get(name,generation) as ArchivedConversation|undefined;
  }
  conversationHistory(name:string,afterGeneration=""):{items:ArchivedConversation[];next:string|null} {
    const rows=this.db.prepare("SELECT * FROM conversation_bindings WHERE name=? AND generation>? ORDER BY generation LIMIT 101").all(name,afterGeneration) as ArchivedConversation[];
    return {items:rows.slice(0,100),next:rows.length>100?rows[99]!.generation:null};
  }
  put(agent:AgentRecord):void {
    this.db.transaction(()=>{
    const previous=this.agent(agent.name);if(previous)this.archiveConversation(previous);
    this.archiveConversation(agent);
    this.db.prepare(`INSERT INTO agents VALUES(@name,@generation,@role,@cwd,@release,@thread_id,@turn_id,@pid,@process_start,@state,@request_hash,@config_json,@sequence)
      ON CONFLICT(name) DO UPDATE SET generation=excluded.generation,role=excluded.role,cwd=excluded.cwd,release=excluded.release,
      thread_id=excluded.thread_id,turn_id=excluded.turn_id,pid=excluded.pid,process_start=excluded.process_start,state=excluded.state,
      request_hash=excluded.request_hash,config_json=excluded.config_json,sequence=excluded.sequence`).run(agent);
    }).immediate();
  }
  change(name:string,generation:string,values:Partial<Pick<AgentRecord,"state"|"thread_id"|"turn_id">>):void {
    const row=this.agent(name);if(!row||row.generation!==generation)return;
    this.put({...row,...values,sequence:row.sequence+1});
  }
  question(id:string):QuestionRecord|undefined{return this.db.prepare("SELECT * FROM questions WHERE question_id=?").get(id) as QuestionRecord|undefined;}
  questions(name:string):QuestionRecord[]{return this.db.prepare("SELECT * FROM questions WHERE agent=? AND state IN ('pending','answering') ORDER BY created_at,question_id").all(name) as QuestionRecord[];}
  addQuestion(row:QuestionRecord):void{this.db.prepare("INSERT INTO questions VALUES(@question_id,@agent,@generation,@thread_id,@turn_id,@rpc_id_json,@kind,@payload_json,@state,@answer_hash,@created_at)").run(row);}
  cacheItem(agent:string,generation:string,item:ConversationItem):void {
    this.db.transaction(()=>{
      const sequence=(this.db.prepare("UPDATE observation_item_sequence SET sequence=sequence+1 WHERE singleton=1 RETURNING sequence").get() as {sequence:number}).sequence;
      this.db.prepare("INSERT INTO observation_items(agent,generation,item_id,item_json,observed_at,sequence) VALUES(?,?,?,?,?,?) ON CONFLICT(agent,generation,item_id) DO UPDATE SET item_json=excluded.item_json,observed_at=excluded.observed_at,sequence=excluded.sequence").run(agent,generation,`${item.turn_id}:${item.id}`,JSON.stringify(item),new Date().toISOString(),sequence);
      const rows=this.db.prepare("SELECT item_id,length(CAST(item_json AS BLOB)) AS bytes FROM observation_items WHERE agent=? AND generation=? ORDER BY sequence DESC").all(agent,generation) as {item_id:string;bytes:number}[];
      let bytes=0;for(let i=0;i<rows.length;i++){bytes+=rows[i]!.bytes;if(i>=200||bytes>524288)this.db.prepare("DELETE FROM observation_items WHERE agent=? AND generation=? AND item_id=?").run(agent,generation,rows[i]!.item_id);}
    }).immediate();
  }
  cachedItems(agent:string,generation:string):ConversationItem[] {
    this.db.prepare("DELETE FROM observation_items WHERE observed_at<?").run(new Date(Date.now()-86400_000).toISOString());
    return (this.db.prepare("SELECT item_json FROM observation_items WHERE agent=? AND generation=? ORDER BY sequence").all(agent,generation) as {item_json:string}[]).flatMap(r=>{const item=sanitizeConversationItem(JSON.parse(r.item_json));return item?[item]:[];});
  }
  observe(agent:string,generation:string,event:Omit<ObservationEvent,"sequence"|"observed_at">):void {
    this.db.transaction(()=>{
      const now=new Date().toISOString();
      const seq=Number(this.db.prepare("INSERT INTO observation_events(agent,generation,observed_at,event_json) VALUES(?,?,?,?)").run(agent,generation,now,JSON.stringify(event)).lastInsertRowid);
      this.db.prepare("INSERT INTO observation_cursors(agent,generation,last_sequence) VALUES(?,?,?) ON CONFLICT(agent,generation) DO UPDATE SET last_sequence=excluded.last_sequence").run(agent,generation,seq);
      this.pruneObservations(agent,generation);
    }).immediate();
  }
  expireObservations():void {
    this.db.transaction(()=>{
      const cutoff=new Date(Date.now()-86400_000).toISOString();
      this.db.prepare("UPDATE observation_cursors SET discarded_through=MAX(discarded_through,COALESCE((SELECT MAX(sequence) FROM observation_events e WHERE e.agent=observation_cursors.agent AND e.generation=observation_cursors.generation AND observed_at<?),0)) WHERE EXISTS (SELECT 1 FROM observation_events e WHERE e.agent=observation_cursors.agent AND e.generation=observation_cursors.generation AND observed_at<?)").run(cutoff,cutoff);
      this.db.prepare("DELETE FROM observation_events WHERE observed_at<?").run(cutoff);
      this.db.prepare("DELETE FROM observation_items WHERE observed_at<?").run(cutoff);
    }).immediate();
  }
  pruneObservations(agent:string,generation:string):void {
    const cutoff=new Date(Date.now()-86400_000).toISOString();
    const rows=this.db.prepare("SELECT sequence FROM observation_events WHERE agent=? AND generation=? AND (observed_at<? OR sequence NOT IN (SELECT sequence FROM observation_events WHERE agent=? AND generation=? ORDER BY sequence DESC LIMIT 1000))").all(agent,generation,cutoff,agent,generation) as {sequence:number}[];
    if(!rows.length)return;
    const through=Math.max(...rows.map(r=>r.sequence));
    this.db.prepare("UPDATE observation_cursors SET discarded_through=MAX(discarded_through,?) WHERE agent=? AND generation=?").run(through,agent,generation);
    this.db.prepare("DELETE FROM observation_events WHERE agent=? AND generation=? AND sequence<=?").run(agent,generation,through);
  }
  observations(agent:string,generation:string,after?:number):{events:ObservationEvent[];cursor:number;oldest_sequence:number;gap:boolean} {
    return this.db.transaction(()=>{
      this.pruneObservations(agent,generation);
      const watermark=this.db.prepare("SELECT last_sequence,discarded_through FROM observation_cursors WHERE agent=? AND generation=?").get(agent,generation) as {last_sequence:number;discarded_through:number}|undefined;
      const rows=this.db.prepare("SELECT * FROM observation_events WHERE agent=? AND generation=? AND sequence>? ORDER BY sequence LIMIT 1000").all(agent,generation,after??0) as {sequence:number;observed_at:string;event_json:string}[];
      const events:ObservationEvent[]=[];let bytes=0,clipped=false;
      for(const row of rows){const event={...JSON.parse(row.event_json),sequence:row.sequence,observed_at:row.observed_at} as ObservationEvent;bytes+=Buffer.byteLength(JSON.stringify(event));if(bytes>262144){clipped=true;break;}events.push(event);}
      return {events,cursor:clipped?events.at(-1)?.sequence??after??0:watermark?.last_sequence??0,oldest_sequence:(this.db.prepare("SELECT MIN(sequence) AS seq FROM observation_events WHERE agent=? AND generation=?").get(agent,generation) as {seq:number|null}).seq??watermark?.last_sequence??0,gap:clipped||(after??0)<(watermark?.discarded_through??0)||(after!==undefined&&after>(watermark?.last_sequence??0))||events.some(e=>e.kind==="gap")};
    }).immediate();
  }
  close():void{this.db.close();}
}
