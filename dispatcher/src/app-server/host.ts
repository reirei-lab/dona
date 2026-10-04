import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { AppServerManager,type StartAgent } from "./manager.js";
import { RuntimeStore } from "./store.js";
import { AppServerRpc } from "./rpc.js";
import {identity,same,type ProcessIdentity} from "./process.js";

export interface HostConfig {socket:string;database:string;codex:string;buildSha:string}
export async function serveRuntime(config:HostConfig):Promise<http.Server> {
  const directory=path.dirname(config.socket);fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const stat=fs.lstatSync(directory);if(stat.isSymbolicLink()||stat.uid!==process.getuid?.()||(stat.mode&0o022))throw Error("runtime_socket_directory_unsafe");
  const store=new RuntimeStore(config.database);
  const owner=identity(process.pid);if(!owner)throw Error("runtime_host_identity_missing");
  // SQLiteのwriter lock内で旧hostのidentityを照合する。二つのhostがagentを所有しない。
  store.db.exec("CREATE TABLE IF NOT EXISTS host_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),identity_json TEXT NOT NULL,socket TEXT NOT NULL)");
  try {
    store.db.transaction(()=>{
      const previous=store.db.prepare("SELECT * FROM host_owner WHERE singleton=1").get() as {identity_json:string;socket:string}|undefined;
      if(previous) {
        const old=JSON.parse(previous.identity_json) as ProcessIdentity;
        if(same(old,identity(old.pid)))throw Error("runtime_host_already_running");
        if(previous.socket!==config.socket)throw Error("runtime_host_socket_changed");
      }
      if(fs.existsSync(config.socket)) {
        const socketStat=fs.lstatSync(config.socket);
        if(!previous||!socketStat.isSocket()||socketStat.uid!==owner.uid)throw Error("runtime_socket_owner_unknown");
        fs.unlinkSync(config.socket);
      }
      store.db.prepare("INSERT INTO host_owner VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET identity_json=excluded.identity_json,socket=excluded.socket").run(JSON.stringify(owner),config.socket);
    }).immediate();
  }catch(error){store.close();throw error;}
  const manager=new AppServerManager(store,(args,cwd)=>new AppServerRpc(config.codex,args,cwd));
  const server=http.createServer(async(request,response)=>{
    const send=(status:number,value:unknown)=>{response.writeHead(status,{"content-type":"application/json"});response.end(JSON.stringify(value));};
    if(request.url==="/health/version"&&request.method==="GET"){send(200,{service:"runtime",status:"ready",build_sha:config.buildSha});return;}
    if(request.url!=="/control"||request.method!=="POST"){send(404,{error:"not_found"});return;}
    try {
      let text="";for await(const chunk of request){text+=String(chunk);if(Buffer.byteLength(text)>1_048_576)throw Error("runtime_request_limit");}
      const p=JSON.parse(text) as Record<string,unknown>;if(typeof p.action!=="string")throw Error("runtime_action_invalid");
      if(!["list","start","pendingQuestions"].includes(p.action)&&typeof p.name!=="string")throw Error("runtime_name_required");
      const name=p.name as string;
      let result:unknown;
      switch(p.action) {
        case "list":result=store.agents().map(r=>manager.status(r.name));break;
        case "status":result=manager.status(name)??null;break;
        case "start": {
          const input=p.input as StartAgent;
          if(!input||!["main","worker"].includes(input.role)||!Array.isArray(input.args)||input.args.some(v=>typeof v!=="string")||!input.threadConfig||typeof input.threadConfig!=="object")throw Error("runtime_start_invalid");
          result=await manager.start(input);break;
        }
        case "prompt":if(typeof p.key!=="string"||typeof p.text!=="string"||p.key.length>256)throw Error("runtime_prompt_invalid");result=await manager.prompt(name,p.key,p.text);break;
        case "questions":result=p.includeResolved===true?store.db.prepare("SELECT q.* FROM questions q JOIN agents a ON a.name=q.agent AND a.generation=q.generation WHERE q.agent=? ORDER BY q.created_at DESC LIMIT 100").all(name):store.questions(name);break;
        case "pendingQuestions":result=store.db.prepare("SELECT q.* FROM questions q JOIN agents a ON a.name=q.agent AND a.generation=q.generation WHERE q.state='pending' AND a.role='worker' ORDER BY q.created_at LIMIT 100").all();break;
        case "answer":if(typeof p.id!=="string"||!p.answers||typeof p.answers!=="object"||Array.isArray(p.answers))throw Error("runtime_answer_invalid");result=await manager.answer(name,p.id,p.answers as Record<string,{answers:string[]}>);break;
        case "approve":if(typeof p.id!=="string"||typeof p.accepted!=="boolean")throw Error("runtime_approval_invalid");result=await manager.approve(name,p.id,p.accepted);break;
        case "stop":if(typeof p.generation!=="string")throw Error("runtime_generation_required");result=await manager.stop(name,p.generation);break;
        default:throw Error("runtime_action_unknown");
      }
      send(200,{result});
    } catch(error) {
      // App Serverの詳細エラーには入力本文が含まれ得る。公開エラーは識別子のみ。
      const message=error instanceof Error&&/^runtime_[a-z_]+$/.test(error.message)?error.message:"runtime_operation_failed";
      send(409,{error:message});
    }
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(config.socket,()=>{fs.chmodSync(config.socket,0o600);resolve();});});
  server.on("close",()=>{try{fs.unlinkSync(config.socket);}catch{}store.db.prepare("DELETE FROM host_owner WHERE identity_json=?").run(JSON.stringify(owner));store.close();});
  return server;
}
