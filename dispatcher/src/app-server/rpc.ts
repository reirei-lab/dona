import { spawn, ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { EventEmitter } from "node:events";

export type RpcId = string | number;
export interface RpcMessage { id?: RpcId; method?: string; params?: unknown; result?: unknown; error?: {code:number;message:string} }
export interface UnixTransport { socketPath:string; attachPid?:number }
export class RpcSpawnFailure extends Error {}
export class RpcFailure extends Error {
  constructor(message:string,readonly acceptance:"not_sent"|"rejected"|"unknown",readonly code?:number) {super(message);}
}

/** 一つのApp Serverへの持続接続。request IDは接続世代の外で再利用しない。 */
export class AppServerRpc extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  private socket?:WebSocket;
  private unix:UnixTransport|undefined;
  private spawnResult:Promise<boolean>;
  private sequence=0;
  private buffer="";
  private ended=false;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();

  constructor(executable:string,args:readonly string[],cwd:string,env:NodeJS.ProcessEnv=process.env,unix?:UnixTransport) {
    super();
    this.unix=unix;
    if(unix){
      const parent=fs.lstatSync(path.dirname(unix.socketPath));
      if(parent.isSymbolicLink()||!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o077))throw new RpcSpawnFailure("runtime_socket_directory_unsafe");
      if(!unix.attachPid)for(const file of [unix.socketPath,unix.socketPath+".identity"]){
        try {fs.lstatSync(file);throw new RpcSpawnFailure("runtime_socket_collision");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      }
    }
    if(unix?.attachPid){this.child=new ChildProcess() as ChildProcessWithoutNullStreams;Object.defineProperty(this.child,"pid",{value:unix.attachPid});this.spawnResult=Promise.resolve(true);return;}
    try {this.child=spawn(executable,[...args,"app-server",...(unix?["--listen",`unix://${unix.socketPath}`]:["--stdio"])],{cwd,env,stdio:["pipe","pipe","pipe"],detached:true});}
    catch {throw new RpcSpawnFailure("runtime_spawn_failed");}
    this.spawnResult=new Promise(resolve=>{this.child.once("spawn",()=>resolve(true));this.child.once("error",()=>resolve(false));});
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data",(chunk:string)=>{if(!this.unix)this.consume(chunk);});
    // stderrは秘密情報を含み得る。詰まりを防ぐため消費するが通知本文へ転記しない。
    this.child.stderr.on("data",()=>{});
    this.child.once("error",()=>this.disconnected());
    this.child.once("exit",()=>this.disconnected());
    this.child.once("close",()=>this.disconnected());
    this.child.stdin.on("error",()=>this.disconnected());
  }

  async confirmSpawn():Promise<void>{if(!await this.spawnResult)throw new RpcSpawnFailure("runtime_spawn_failed");}

  async initialize():Promise<void> {
    if(this.unix)await this.connectUnix();
    await this.request("initialize",{clientInfo:{name:"dona-runtime",version:"1.0.0"},capabilities:{experimentalApi:true}},30_000);
    this.send({method:"initialized"});
  }

  request(method:string,params:unknown,timeoutMs=30_000):Promise<unknown> {
    if(this.ended||(this.unix?this.socket?.readyState!==WebSocket.OPEN:!this.child.stdin.writable))return Promise.reject(new RpcFailure("app_server_disconnected","not_sent"));
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
    if(this.ended||(this.unix?this.socket?.readyState!==WebSocket.OPEN:!this.child.stdin.writable))throw new RpcFailure("app_server_disconnected","not_sent");
    if(this.unix)this.socket!.send(JSON.stringify(value));else this.child.stdin.write(JSON.stringify(value)+"\n");
  }
  private async connectUnix():Promise<void> {
    const file=this.unix!.socketPath;
    const deadline=Date.now()+10_000;
    while(!fs.existsSync(file)&&Date.now()<deadline&&!this.ended)await new Promise(r=>setTimeout(r,25));
    const link=fs.lstatSync(file);
    if(link.uid!==process.getuid?.())throw Error("runtime_socket_unsafe");
    const target=link.isSymbolicLink()?fs.readlinkSync(file):file;
    if(!path.isAbsolute(target))throw Error("runtime_socket_unsafe");
    const parent=fs.lstatSync(path.dirname(target)),stat=fs.lstatSync(target);
    if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o077)||!stat.isSocket()||stat.uid!==process.getuid?.())throw Error("runtime_socket_unsafe");
    const identityFile=file+".identity",captured={target,dev:stat.dev,ino:stat.ino};
    if(this.unix!.attachPid){
      const saved=fs.lstatSync(identityFile);
      if(!saved.isFile()||saved.isSymbolicLink()||saved.uid!==process.getuid?.()||(saved.mode&0o077)||JSON.stringify(JSON.parse(fs.readFileSync(identityFile,"utf8")))!==JSON.stringify(captured))throw Error("runtime_socket_identity_changed");
    }else fs.writeFileSync(identityFile,JSON.stringify(captured),{flag:"wx",mode:0o600});
    if(stat.mode&0o077)throw Error("runtime_socket_unsafe");
    await new Promise<void>((resolve,reject)=>{
      const socket=new WebSocket(`ws+unix://${target}:/`,{maxPayload:16*1024*1024,handshakeTimeout:10_000});this.socket=socket;
      socket.once("open",resolve);socket.once("error",reject);
      socket.on("message",(data,binary)=>{if(binary){this.disconnected();return;}this.consume(data.toString()+"\n");});
      socket.on("close",()=>this.disconnected());socket.on("error",()=>this.disconnected());
    });
  }
  closeConnection():void {this.socket?.terminate();this.disconnected();}
  private consume(chunk:string):void {
    if(this.ended)return;
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
    if(this.ended)return;this.ended=true;this.socket?.terminate();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new RpcFailure("app_server_connection_lost","unknown"));}
    this.pending.clear();this.emit("disconnect");
  }
  get connected():boolean {return !this.ended&&(!this.unix||this.socket?.readyState===WebSocket.OPEN);}
}
