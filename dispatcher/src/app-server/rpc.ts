import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export type RpcId = string | number;
export interface RpcMessage { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: {code:number;message:string} }
export class RpcFailure extends Error {
  constructor(message:string,readonly acceptance:"not_sent"|"rejected"|"unknown",readonly code?:number) {super(message);}
}

/** 一つのApp Serverへの持続接続。request IDは接続世代の外で再利用しない。 */
export class AppServerRpc extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private sequence=0;
  private buffer="";
  private ended=false;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();

  constructor(executable:string,args:readonly string[],cwd:string,env:NodeJS.ProcessEnv=process.env) {
    super();
    this.child=spawn(executable,[...args,"app-server","--stdio"],{cwd,env,stdio:["pipe","pipe","pipe"],detached:true});
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data",(chunk:string)=>this.consume(chunk));
    // stderrは秘密情報を含み得る。詰まりを防ぐため消費するが通知本文へ転記しない。
    this.child.stderr.on("data",()=>{});
    this.child.once("error",()=>this.disconnected());
    this.child.once("close",()=>this.disconnected());
    this.child.stdin.on("error",()=>this.disconnected());
  }

  async initialize():Promise<void> {
    await this.request("initialize",{clientInfo:{name:"dona-runtime",version:"1.0.0"},capabilities:{experimentalApi:true}},30_000);
    this.send({method:"initialized"});
  }

  request(method:string,params:unknown,timeoutMs=30_000):Promise<unknown> {
    if(this.ended||!this.child.stdin.writable)return Promise.reject(new RpcFailure("app_server_disconnected","not_sent"));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new RpcFailure("app_server_response_timeout","unknown"));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try {this.send({id,method,params});}
      catch(error) {clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }

  respond(id:RpcId,result:unknown):void {this.send({id,result});}
  reject(id:RpcId,message="Unsupported request"):void {this.send({id,error:{code:-32601,message}});}
  private send(value:RpcMessage):void {
    if(this.ended||!this.child.stdin.writable)throw new RpcFailure("app_server_disconnected","not_sent");
    this.child.stdin.write(JSON.stringify(value)+"\n");
  }
  private consume(chunk:string):void {
    this.buffer+=chunk;
    if(Buffer.byteLength(this.buffer)>16*1024*1024){this.disconnected();return;}
    let newline:number;
    while((newline=this.buffer.indexOf("\n"))>=0) {
      const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);
      if(!line.trim())continue;
      let message:RpcMessage;
      try {message=JSON.parse(line) as RpcMessage;if(!message||typeof message!=="object")throw Error();}
      catch {this.disconnected();return;}
      if(message.method) {this.emit(message.id===undefined?"notification":"request",message);continue;}
      if(typeof message.id!=="number")continue;
      const pending=this.pending.get(message.id);if(!pending)continue;
      clearTimeout(pending.timer);this.pending.delete(message.id);
      if(message.error)pending.reject(new RpcFailure(message.error.message,"rejected",message.error.code));
      else pending.resolve(message.result);
    }
  }
  private disconnected():void {
    if(this.ended)return;this.ended=true;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new RpcFailure("app_server_connection_lost","unknown"));}
    this.pending.clear();this.emit("disconnect");
  }
  get connected():boolean {return !this.ended;}
}
