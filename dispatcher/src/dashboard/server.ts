import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DashboardTaskReader } from "./task-reader.js";
import type { DashboardObserver, DashboardAuthority } from "./observer.js";

interface Session { csrf: string; expires: number; revision: string }
export interface DashboardServerOptions {
  origin: string; port: number; controlSocket: string; version: string;
  reader: DashboardTaskReader; observer: DashboardObserver;
  page: {status: number; headers: Record<string,string>; body: string};
}
const cookieName = "__Host-dona-observer";
const headers = {"cache-control":"no-store", "referrer-policy":"no-referrer", "x-content-type-options":"nosniff",
  "content-security-policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"};
const equal = (a: string, b: string) => { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y); };
export class DashboardServer {
  private readonly server: http.Server;
  private readonly control: http.Server;
  private readonly origin: URL;
  private readonly sessions = new Map<string,Session>();
  private pairing: {code:string; expires:number} | undefined;
  private failures = 0;
  private failureWindow = 0;
  private controlIdentity: {dev:number;ino:number} | undefined;
  private active = 0;
  private closed = false;
  constructor(private readonly options: DashboardServerOptions) {
    this.origin = new URL(options.origin);
    if (this.origin.protocol!=="https:" || this.origin.origin!==options.origin || this.origin.username || this.origin.password
      || !Number.isSafeInteger(options.port) || options.port<1024 || options.port>65535) throw Error("dashboard_configuration_invalid");
    this.server=http.createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:5000},(req,res)=>{void this.receive(req,res);});
    this.control=http.createServer({maxHeaderSize:2048,requestTimeout:5000,headersTimeout:3000},(req,res)=>this.operator(req,res));
    for(const server of [this.server,this.control]) {
      server.maxRequestsPerSocket=1;server.keepAliveTimeout=1;server.maxConnections=32;
      server.on("upgrade",(_req,socket)=>socket.destroy());server.on("connect",(_req,socket)=>socket.destroy());
      server.on("clientError",(_error,socket)=>socket.destroy());
    }
  }
  private reply(res:http.ServerResponse,status:number,value:unknown,type="application/json; charset=utf-8",extra:Record<string,string>={}):void {
    if(res.destroyed)return;
    const body=type.startsWith("application/json")?JSON.stringify(value):String(value);
    res.writeHead(status,{...headers,"content-type":type,"content-length":Buffer.byteLength(body),connection:"close",...extra});res.end(body);
  }
  private session(req:http.IncomingMessage):{key:string;value:Session}|null {
    const cookies=(req.headers.cookie??"").split(";").map(x=>x.trim()).filter(x=>x.startsWith(`${cookieName}=`));
    if(cookies.length!==1)return null;
    const key=cookies[0]!.slice(cookieName.length+1),value=this.sessions.get(key);
    if(!value || performance.now()>=value.expires){this.sessions.delete(key);return null;}
    return {key,value};
  }
  private cookie(value:string,age=43200):string{return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;}
  private async body(req:http.IncomingMessage):Promise<Record<string,unknown>> {
    if(req.headers["content-type"]!=="application/json" || req.headers["transfer-encoding"]!==undefined)throw Error("body_invalid");
    const length=req.headers["content-length"];
    if(!length||!/^\d{1,4}$/.test(length)||Number(length)>1024)throw Error("body_invalid");
    const chunks:Buffer[]=[];let bytes=0;
    for await(const part of req){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>1024)throw Error("body_invalid");chunks.push(chunk);}
    if(bytes!==Number(length))throw Error("body_invalid");
    const result=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))) as unknown;
    if(!result||typeof result!=="object"||Array.isArray(result))throw Error("body_invalid");return result as Record<string,unknown>;
  }
  private async receive(req:http.IncomingMessage,res:http.ServerResponse):Promise<void> {
    if(this.closed||this.active>=16){this.reply(res,503,{error:"unavailable"});return;}
    this.active++;
    try {
      const counts=new Map<string,number>();for(let i=0;i<req.rawHeaders.length;i+=2){const key=req.rawHeaders[i]!.toLowerCase();counts.set(key,(counts.get(key)??0)+1);}
      if(["host","origin","cookie","content-length","content-type","x-csrf-token"].some(name=>(counts.get(name)??0)>1))throw Error("headers_invalid");
      if(req.socket.remoteAddress!=="127.0.0.1" || req.headers.host!==this.origin.host
        || (req.headers.origin!==undefined&&req.headers.origin!==this.origin.origin)
        || ![undefined,"same-origin","none"].includes(req.headers["sec-fetch-site"] as string|undefined)
        || (req.method!=="GET"&&req.headers.origin!==this.origin.origin)) {this.reply(res,403,{error:"origin_invalid"});return;}
      const target=req.url??"";
      if(req.method==="GET"&&(target==="/"||target==="/pair")){this.reply(res,200,this.options.page.body,"text/html; charset=utf-8",this.options.page.headers);return;}
      if(req.method==="GET"&&target==="/health/version"){this.reply(res,200,{version:this.options.version,mode:"read_only",pairing_required:true});return;}
      if(req.method==="POST"&&target==="/api/pair"){
        const now=performance.now();if(now-this.failureWindow>60000){this.failureWindow=now;this.failures=0;}
        if(this.failures>=8){this.reply(res,429,{error:"pairing_rate_limited"});return;}
        const body=await this.body(req);this.failures++;
        if(Object.keys(body).length!==1||typeof body.code!=="string"||!this.pairing||performance.now()>=this.pairing.expires||!equal(body.code,this.pairing.code)) {this.reply(res,403,{error:"pairing_invalid"});return;}
        this.pairing=undefined;
        for(const [key,value] of this.sessions)if(now>=value.expires)this.sessions.delete(key);
        if(this.sessions.size>=16){this.reply(res,429,{error:"session_limit"});return;}
        const key=randomBytes(32).toString("base64url"),csrf=randomBytes(32).toString("base64url");
        this.sessions.set(key,{csrf,expires:performance.now()+12*3600000,revision:randomBytes(16).toString("hex")});
        this.reply(res,200,{csrf},undefined,{"set-cookie":this.cookie(key)});return;
      }
      const session=this.session(req);
      if(!session){this.reply(res,401,{error:"session_invalid"});return;}
      if(req.method==="GET"&&target==="/api/session"){this.reply(res,200,{csrf:session.value.csrf,scope:"dona_observation"});return;}
      if(req.method==="POST"&&target==="/api/logout"){
        if(typeof req.headers["x-csrf-token"]!=="string"||!equal(req.headers["x-csrf-token"],session.value.csrf)){this.reply(res,403,{error:"csrf_invalid"});return;}
        this.sessions.delete(session.key);this.reply(res,200,{ok:true},undefined,{"set-cookie":this.cookie("",0)});return;
      }
      const authority=():DashboardAuthority|null=>{
        const current=this.session(req);return current?.key===session.key?{revision:current.value.revision,task:()=>true,conversation:()=>true}:null;
      };
      const url=new URL(target,this.origin);
      if(req.method==="GET"&&url.pathname==="/api/tasks"){
        const keys=[...url.searchParams.keys()];if(keys.some(k=>k!=="after")||keys.length>1)throw Error("query_invalid");
        const result=this.options.reader.list(()=>true,url.searchParams.get("after"));
        this.reply(res,200,result);return;
      }
      const match=/^\/api\/tasks\/([A-Za-z0-9_-]{1,128})(\/events)?$/.exec(target);
      if(req.method==="GET"&&match){
        const detail=await this.options.observer.detail(match[1]!,authority);
        if(!authority()){this.reply(res,401,{error:"session_invalid"});return;}
        if(!detail){this.reply(res,404,{error:"not_found"});return;}
        if(match[2])this.reply(res,200,`event: task\ndata: ${JSON.stringify(detail)}\n\n`,"text/event-stream; charset=utf-8");
        else this.reply(res,200,detail);return;
      }
      this.reply(res,404,{error:"not_found"});
    } catch {this.reply(res,503,{error:"observation_unavailable"});}
    finally {this.active--;}
  }
  private operator(req:http.IncomingMessage,res:http.ServerResponse):void {
    if(req.method==="GET"&&req.url==="/health/version"){this.reply(res,200,{version:this.options.version,mode:"read_only",sessions:this.sessions.size});return;}
    if(req.method!=="POST"||req.headers["content-length"]!=="0"||req.headers["transfer-encoding"]!==undefined){this.reply(res,400,{error:"invalid_request"});return;}
    if(req.url==="/pair"){
      const code=randomBytes(12).toString("base64url");this.pairing={code,expires:performance.now()+300000};this.failures=0;
      this.reply(res,200,{code,expires_in_seconds:300,origin:this.origin.origin,scope:"all_dona_observations"});return;
    }
    if(req.url==="/revoke"){this.sessions.clear();this.pairing=undefined;this.reply(res,200,{ok:true});return;}
    this.reply(res,404,{error:"not_found"});
  }
  async start():Promise<void> {
    const socket=this.options.controlSocket,parent=path.dirname(socket),uid=process.getuid?.();
    if(uid===undefined||!path.isAbsolute(socket)||Buffer.byteLength(socket)>100||fs.realpathSync(parent)!==parent)throw Error("dashboard_control_invalid");
    const directory=fs.lstatSync(parent);
    if(!directory.isDirectory()||directory.uid!==uid||(directory.mode&0o777)!==0o700 )throw Error("dashboard_control_invalid");
    await this.removeStaleControl(socket,uid);
    try {
      await new Promise<void>((resolve,reject)=>{this.control.once("error",reject);this.control.listen(socket,()=>{this.control.off("error",reject);resolve();});});
      fs.chmodSync(socket,0o600);const stat=fs.lstatSync(socket);this.controlIdentity={dev:stat.dev,ino:stat.ino};
      await new Promise<void>((resolve,reject)=>{this.server.once("error",reject);this.server.listen(this.options.port,"127.0.0.1",()=>{this.server.off("error",reject);resolve();});});
    } catch(error){await this.close();throw error;}
  }
  private async removeStaleControl(socket:string,uid:number):Promise<void> {
    let before:fs.Stats;try{before=fs.lstatSync(socket);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
    if(!before.isSocket()||before.uid!==uid||(before.mode&0o777)!==0o600)throw Error("dashboard_control_invalid");
    const refused=await new Promise<boolean>(resolve=>{
      const probe=net.createConnection(socket);let settled=false;
      const finish=(value:boolean)=>{if(settled)return;settled=true;probe.destroy();resolve(value);};
      probe.setTimeout(1000,()=>finish(false));probe.once("connect",()=>finish(false));
      probe.once("error",error=>finish((error as NodeJS.ErrnoException).code==="ECONNREFUSED"));
    });
    if(!refused)throw Error("dashboard_control_in_use");
    const after=fs.lstatSync(socket);
    if(after.dev!==before.dev||after.ino!==before.ino||!after.isSocket()||after.uid!==uid)throw Error("dashboard_control_changed");
    fs.unlinkSync(socket);
  }
  async close():Promise<void> {
    this.closed=true;this.sessions.clear();this.pairing=undefined;
    for(const server of [this.server,this.control]){server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));}
    const socket=this.options.controlSocket;
    if(this.controlIdentity&&fs.existsSync(socket)){const stat=fs.lstatSync(socket);if(stat.dev===this.controlIdentity.dev&&stat.ino===this.controlIdentity.ino)fs.unlinkSync(socket);}
  }
}
