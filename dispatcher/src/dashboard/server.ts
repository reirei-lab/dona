import {commandRejectionSchema} from './operator-rejection.js';
import http from "node:http";
import {OperatorStream} from "./operator-stream.js";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { DashboardTaskReader } from "./task-reader.js";
import type { DashboardObserver, DashboardAuthority } from "./observer.js";

import { validateOperatorSession, type OperatorBackend, type OperatorSession } from "./operator-client.js";
export interface DashboardServerOptions {
  origin: string; port: number; controlSocket: string; version: string;
  backend: OperatorBackend;
  reader: DashboardTaskReader; observer: DashboardObserver;
  page: {status: number; headers: Record<string,string>; body: string};
}
const cookieName = "__Host-dona-observer";
const headers = {"cache-control":"no-store", "referrer-policy":"no-referrer", "x-content-type-options":"nosniff",
  "content-security-policy":"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"};
const equal = (a: string, b: string) => { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y); };
export class DashboardServer {
  private readonly stream=new OperatorStream();
  private readonly server: http.Server;
  private readonly control: http.Server;
  private readonly origin: URL;
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
    this.control=http.createServer({maxHeaderSize:2048,requestTimeout:5000,headersTimeout:3000},(req,res)=>{void this.operator(req,res);});
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
  private token(req:http.IncomingMessage):string|null {
    const cookies=(req.headers.cookie??"").split(";").map(x=>x.trim()).filter(x=>x.startsWith(`${cookieName}=`));
    if(cookies.length!==1)return null;const token=cookies[0]!.slice(cookieName.length+1);
    return /^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
  }
  private async session(token:string):Promise<OperatorSession|null> {
    const value=await this.options.backend.call('session',{token});
    return value===null?null:validateOperatorSession(value);
  }
  private cookie(value:string,age=43200):string{return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;}
  private async body(req:http.IncomingMessage):Promise<Record<string,unknown>> {
    if(req.headers["content-type"]!=="application/json" || req.headers["transfer-encoding"]!==undefined)throw Error("body_invalid");
    const length=req.headers["content-length"];
    if(!length||!/^\d{1,6}$/.test(length)||Number(length)>524288)throw Error("body_invalid");
    const chunks:Buffer[]=[];let bytes=0;
    for await(const part of req){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>524288)throw Error("body_invalid");chunks.push(chunk);}
    if(bytes!==Number(length))throw Error("body_invalid");
    const result=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))) as unknown;
    if(!result||typeof result!=="object"||Array.isArray(result))throw Error("body_invalid");return result as Record<string,unknown>;
  }
  private async receive(req:http.IncomingMessage,res:http.ServerResponse):Promise<void> {
    if(this.closed||this.active>=16){this.reply(res,503,{error:"unavailable"});return;}
    this.active++;
    try {
      const counts=new Map<string,number>();for(let i=0;i<req.rawHeaders.length;i+=2){const key=req.rawHeaders[i]!.toLowerCase();counts.set(key,(counts.get(key)??0)+1);}
      if(["host","origin","cookie","content-length","content-type","x-csrf-token","last-event-id"].some(name=>(counts.get(name)??0)>1))throw Error("headers_invalid");
      if(req.socket.remoteAddress!=="127.0.0.1" || req.headers.host!==this.origin.host
        || (req.headers.origin!==undefined&&req.headers.origin!==this.origin.origin)
        || ![undefined,"same-origin","none"].includes(req.headers["sec-fetch-site"] as string|undefined)
        || (req.method!=="GET"&&req.headers.origin!==this.origin.origin)) {this.reply(res,403,{error:"origin_invalid"});return;}
      const target=req.url??"";
      if(req.method==="GET"&&(target==="/"||target==="/pair")){this.reply(res,200,this.options.page.body,"text/html; charset=utf-8",this.options.page.headers);return;}
      if(req.method==="GET"&&target==="/health/version"){this.reply(res,200,{version:this.options.version,mode:"paired_operator",pairing_required:true});return;}
      if(req.method==="POST"&&target==="/api/pair"){
        const now=performance.now();if(now-this.failureWindow>60000){this.failureWindow=now;this.failures=0;}
        if(this.failures>=8){this.reply(res,429,{error:"pairing_rate_limited"});return;}
        const body=await this.body(req);this.failures++;
        if(Object.keys(body).length!==1||typeof body.code!=="string"){this.reply(res,403,{error:"pairing_invalid"});return;}
        let paired:{token:string;session:OperatorSession};
        try{paired=await this.options.backend.call('pair',{code:body.code});paired.session=validateOperatorSession(paired.session);if(!/^[A-Za-z0-9_-]{43}$/.test(paired.token))throw Error();}
        catch{this.reply(res,403,{error:"pairing_invalid"});return;}
        this.reply(res,200,paired.session,undefined,{"set-cookie":this.cookie(paired.token)});return;
      }
      const token=this.token(req),session=token?await this.session(token):null;
      if(!token||!session){this.reply(res,401,{error:"session_invalid"});return;}
      if(req.method!=="GET"&&(typeof req.headers["x-csrf-token"]!=="string"||!equal(req.headers["x-csrf-token"],session.csrf))){
        this.reply(res,403,{error:"csrf_invalid"});return;
      }
      if(req.method==="GET"&&target==="/api/session"){this.reply(res,200,session);return;}
      if(req.method==='GET'&&target==='/api/readiness'){
        const health=await this.options.backend.call<{database:unknown;runtime:unknown;operator:unknown;external:{configured:unknown;ready:unknown}}>('admin/health',{});
        if((health.database!=='ready'&&health.database!=='unavailable')||(health.runtime!=='ready'&&health.runtime!=='unavailable')||health.operator!=='ready'
          ||typeof health.external?.configured!=='boolean'||typeof health.external.ready!=='boolean')throw Error('health_invalid');
        if(JSON.stringify(await this.session(token))!==JSON.stringify(session)){this.reply(res,401,{error:'session_invalid'});return;}
        this.reply(res,200,{ready:health.database==='ready'&&health.runtime==='ready'&&(!health.external.configured||health.external.ready),database:health.database,runtime:health.runtime,operator:'ready',external:{configured:health.external.configured,ready:health.external.ready}});return;
      }
      if(req.method==="POST"&&target==="/api/logout"){
        if(typeof req.headers["x-csrf-token"]!=="string"||!equal(req.headers["x-csrf-token"],session.csrf)){this.reply(res,403,{error:"csrf_invalid"});return;}
        await this.options.backend.call('logout',{token});this.reply(res,200,{ok:true},undefined,{"set-cookie":this.cookie("",0)});return;
      }
      const has=(capability:string)=>session.capabilities.includes(capability);
      const authority=():DashboardAuthority=>({revision:JSON.stringify([session.instance_id,session.owner_id,session.device_id,session.grant_revision,session.capabilities]),task:()=>has('tasks:read'),conversation:()=>has('conversations:worker:read'),mainConversation:()=>has('conversations:main:read')});
      const recheck=async()=>{
        const current=await this.session(token);
        if(!current||JSON.stringify(current)!==JSON.stringify(session)){this.reply(res,401,{error:"session_invalid"});return false;}return true;
      };
      const url=new URL(target,this.origin);
      if(req.method==='GET'&&url.pathname==='/api/approvals'){
        const keys=[...url.searchParams.keys()];if(keys.length>1||keys.some(key=>key!=='after'))throw Error('query_invalid');
        const result=await this.options.backend.call('external/list',{token,...(url.searchParams.has('after')?{after:url.searchParams.get('after')}:{})});
        if(!await recheck())return;this.reply(res,200,result);return;
      }
      if(req.method==='POST'&&url.pathname==='/api/approvals/decide'&&!url.search){
        const body=await this.body(req);if(Object.keys(body).some(key=>!['ceremony_id','response'].includes(key)))throw Error('body_invalid');
        const result=await this.options.backend.call('external/decide',{...body,token});
        if(!await recheck())return;this.reply(res,commandRejectionSchema.safeParse(result).success?409:200,result);return;
      }
      const external=/^\/api\/approvals\/([A-Za-z0-9_-]{1,128})(?:\/(options|status))?$/.exec(url.pathname);
      if(external&&!url.search&&((req.method==='GET'&&external[2]!=='options')||(req.method==='POST'&&external[2]==='options'))){
        const body=req.method==='POST'?await this.body(req):{};
        if(Object.keys(body).some(key=>!['decision','presentation_digest'].includes(key)))throw Error('body_invalid');
        const result=await this.options.backend.call('external/'+(external[2]??'present'),{...body,token,request_id:external[1]});
        if(!await recheck())return;this.reply(res,200,result);return;
      }
      const native=/^\/api\/native\/(options|decide)$/.exec(url.pathname);
      if(native&&req.method==='POST'&&!url.search){
        const body=await this.body(req);
        if(Object.keys(body).some(key=>!(native[1]==='options'?['input']:['ceremony_id','response']).includes(key)))throw Error('body_invalid');
        const result=await this.options.backend.call('native/'+native[1],{...body,token});
        if(!await recheck())return;this.reply(res,commandRejectionSchema.safeParse(result).success?409:200,result);return;
      }
      const credential=/^\/api\/credential(?:\/(options|register))?$/.exec(url.pathname);
      if(credential&&!url.search&&((!credential[1]&&req.method==='GET')||(credential[1]&&req.method==='POST'))){
        const body=req.method==='POST'?await this.body(req):{};
        const route=credential[1]??'status';
        if(Object.keys(body).some(key=>!(['register'].includes(route)?['ceremony_id','response']:[]).includes(key)))throw Error('body_invalid');
        const result=await this.options.backend.call('credential/'+route,{...body,token});
        if(!await recheck())return;this.reply(res,200,result);return;
      }
      if(req.method==='POST'&&url.pathname==='/api/tasks'&&!url.search){
        const input=await this.body(req);
        const result=await this.options.backend.call('commands/create',{token,input});
        if(!await recheck())return;this.reply(res,commandRejectionSchema.safeParse(result).success?409:200,result);return;
      }
      const command=/^\/api\/tasks\/([A-Za-z0-9_-]{1,128})\/(cancel|questions\/([A-Za-z0-9_-]{1,128})\/reply)$/.exec(url.pathname);
      if(command&&req.method==='POST'&&!url.search){
        const input=await this.body(req);
        if('task_id' in input||'question_id' in input)throw Error('body_invalid');
        const operation=command[2]==='cancel'?'cancel':'question_reply';
        const result=await this.options.backend.call('commands/'+operation,{token,input:{...input,task_id:command[1],...(command[3]?{question_id:command[3]}:{})}});
        if(!await recheck())return;this.reply(res,commandRejectionSchema.safeParse(result).success?409:200,result);return;
      }
      const receipt=/^\/api\/commands\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
      if(req.method==='GET'&&receipt){
        if([...url.searchParams.keys()].length!==1||!['create','cancel','question_reply','native_approval'].includes(url.searchParams.get('operation')??''))throw Error('query_invalid');
        const result=await this.options.backend.call('commands/receipt',{token,input:{request_id:receipt[1],operation:url.searchParams.get('operation')}});
        if(!await recheck())return;this.reply(res,200,result);return;
      }
      const questions=/^\/api\/tasks\/([A-Za-z0-9_-]{1,128})\/questions$/.exec(url.pathname);
      if(req.method==='GET'&&questions){
        const keys=[...url.searchParams.keys()];if(keys.length>1||keys.some(key=>key!=='kind')||!['question','approval'].includes(url.searchParams.get('kind')??'question'))throw Error('query_invalid');
        const result=await this.options.backend.call('questions',{token,task_id:questions[1],kind:url.searchParams.get('kind')??'question'});
        if(!await recheck())return;this.reply(res,200,result);return;
      }
      if(req.method==="GET"&&url.pathname==="/api/tasks"){
        const keys=[...url.searchParams.keys()];if(keys.some(k=>k!=="after")||keys.length>1)throw Error("query_invalid");
        if(!has("tasks:read")){this.reply(res,403,{error:"scope_denied"});return;}
        const result=this.options.reader.list(()=>true,url.searchParams.get("after"));
        if(!await recheck())return;this.reply(res,200,result);return;
      }
      const match=/^\/api\/tasks\/([A-Za-z0-9_-]{1,128})(\/events)?$/.exec(url.pathname);
      if(req.method==="GET"&&match){
        const keys=[...url.searchParams.keys()];if(keys.some(k=>k!=="attempt")||keys.length>1)throw Error("query_invalid");
        if(!has('tasks:read')){this.reply(res,403,{error:'scope_denied'});return;}
        const attempt=url.searchParams.get('attempt')??undefined,scope=this.stream.scope(authority().revision,['task',match[1],attempt??null]);
        const previous=match[2]?this.stream.read(req.headers['last-event-id'],scope):null;
        const detail=await this.options.observer.detail(match[1]!,authority,previous?.sequence,attempt);
        if(!await recheck())return;
        if(!detail){this.reply(res,404,{error:"not_found"});return;}
        if(match[2])this.reply(res,200,this.stream.frame(scope,detail,previous),"text/event-stream; charset=utf-8");
        else this.reply(res,200,this.stream.snapshot(scope,detail));return;
      }
      const main=/^\/api\/conversations\/main(?:\/([A-Za-z0-9_-]{1,160})\/([A-Za-z0-9_-]{1,160})(\/events)?)?$/.exec(url.pathname);
      if(req.method==='GET'&&main){
        if(url.search)throw Error('query_invalid');if(!has('conversations:main:read')){this.reply(res,403,{error:'scope_denied'});return;}
        const scope=this.stream.scope(authority().revision,['main',main[1],main[2]]),previous=main[3]?this.stream.read(req.headers['last-event-id'],scope):null;
        const result=main[1]?await this.options.observer.mainDetail(main[1],main[2]!,authority,previous?.sequence):await this.options.observer.mainList(authority);
        if(!await recheck())return;
        if(!result){this.reply(res,404,{error:'not_found'});return;}
        if('status'in result){if(main[3])this.reply(res,200,this.stream.frame(scope,result,previous),'text/event-stream; charset=utf-8');else this.reply(res,200,this.stream.snapshot(scope,result));}
        else this.reply(res,200,result);return;
      }
      this.reply(res,404,{error:"not_found"});
    } catch {this.reply(res,503,{error:"observation_unavailable"});}
    finally {this.active--;}
  }
  private async operator(req:http.IncomingMessage,res:http.ServerResponse):Promise<void> {
    try {
      if(req.method==='GET'&&req.url==='/health/version'){const status=await this.options.backend.call<Record<string,unknown>>('admin/status',{});this.reply(res,200,{...status,version:this.options.version,mode:'paired_operator'});return;}
      if(req.method!=='POST'||req.headers['transfer-encoding']!==undefined){this.reply(res,400,{error:'invalid_request'});return;}
      const body=req.headers['content-length']==='0'?{}:await this.body(req);
      if(req.url==='/pair'){
        if(Object.keys(body).some(key=>key!=='capabilities'))throw Error();
        const capabilities=body.capabilities??['tasks:read','conversations:worker:read'];
        if(!Array.isArray(capabilities)||!capabilities.every(c=>typeof c==='string'))throw Error();
        const result=await this.options.backend.call<Record<string,unknown>>('admin/pair',{capabilities});this.failures=0;this.reply(res,200,{...result,origin:this.origin.origin});return;
      }
      if(req.url==='/revoke'){if(Object.keys(body).some(key=>key!=='device_id')||(body.device_id!==undefined&&typeof body.device_id!=='string'))throw Error();this.reply(res,200,await this.options.backend.call('admin/revoke',body));return;}
      this.reply(res,404,{error:'not_found'});
    }catch{this.reply(res,503,{error:'operator_unavailable'});}
  }
  async start():Promise<void> {
    const socket=this.options.controlSocket,parent=path.dirname(socket),uid=process.getuid?.();
    if(uid===undefined||!path.isAbsolute(socket)||Buffer.byteLength(socket)>100||fs.realpathSync(parent)!==parent)throw Error("dashboard_control_invalid");
    const directory=fs.lstatSync(parent);
    if(!directory.isDirectory()||directory.uid!==uid||(directory.mode&0o777)!==0o700 )throw Error("dashboard_control_invalid");
    await this.removeStaleControl(socket,uid);
    const reset=await this.options.backend.call<{ok:boolean}>("admin/reset",{origin:this.options.origin});
    if(reset?.ok!==true)throw Error("dashboard_operator_reset_failed");
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
    this.closed=true;
    for(const server of [this.server,this.control]){server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));}
    const socket=this.options.controlSocket;
    if(this.controlIdentity&&fs.existsSync(socket)){const stat=fs.lstatSync(socket);if(stat.dev===this.controlIdentity.dev&&stat.ino===this.controlIdentity.ino)fs.unlinkSync(socket);}
  }
}
