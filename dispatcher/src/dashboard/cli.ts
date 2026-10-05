#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { RuntimeClient } from "../app-server/client.js";
import { readDashboardConfig } from "./config.js";
import { DashboardTaskReader } from "./task-reader.js";
import { DashboardObserver, type ConversationContent, type ObservedConversation } from "./observer.js";
import { readDashboardRelease, watchDashboardRelease } from "./release-pointer.js";
import { DashboardOperatorClient } from "./operator-client.js";
import { DashboardServer } from "./server.js";

async function main():Promise<void>{
  const [command,file,...extra]=process.argv.slice(2);
  if(!file||!['serve','pair','revoke','status','doctor'].includes(command??''))throw Error('dashboard_arguments_invalid');
  const capabilities:string[]=[];let deviceId:string|undefined;
  for(let i=0;i<extra.length;i+=2){if(!extra[i+1])throw Error('dashboard_arguments_invalid');if(command==='pair'&&extra[i]==='--capability')capabilities.push(extra[i+1]!);else if(command==='revoke'&&extra[i]==='--device'&&!deviceId)deviceId=extra[i+1];else throw Error('dashboard_arguments_invalid');}
  const config=readDashboardConfig(file);
  if(command==='doctor'){
    const status=await new DashboardOperatorClient(config.dispatcher_socket).call<{database:string;runtime:string;operator:string;external:{configured:boolean;ready:boolean;reason?:string}}>('admin/health',{});
    const ready=status.database==='ready'&&status.runtime==='ready'&&status.operator==='ready'&&(!status.external.configured||status.external.ready);
    process.stdout.write(JSON.stringify({config:'ready',ready,...status})+'\n');if(!ready)process.exitCode=1;return;
  }
  if(command==='serve'){
    // Resolve only the paired Web artifact from this immutable release.
    const moduleUrl=new URL('../../../sources/web/dist/observer-dashboard.js',import.meta.url);
    const web=await import(moduleUrl.href) as {observerDashboardPage:()=>{status:200;headers:Record<string,string>;body:string}};
    const manifest=JSON.parse(fs.readFileSync(new URL('../../../release-manifest.json',import.meta.url),'utf8')) as {sha?:unknown;lock_hashes?:Record<string,unknown>};
    if(typeof manifest.sha!=='string'||!/^[a-f0-9]{40}$/.test(manifest.sha)||typeof manifest.lock_hashes?.['sources/web']!=='string'||!/^[a-f0-9]{64}$/.test(manifest.lock_hashes['sources/web'] as string))throw Error('dashboard_release_unverified');
    if(config.active_release_pointer&&readDashboardRelease(config.active_release_pointer).sha!==manifest.sha)throw Error('dashboard_release_changed');
    const reader=new DashboardTaskReader(config.dispatcher_database),client=new RuntimeClient(config.runtime_socket,5000);
    const observer=new DashboardObserver(reader,{
      conversations:after=>client.call<{items:ObservedConversation[];next:string|null}>('conversations',after?{after}:{}),
      conversationHistory:(name,afterGeneration)=>client.conversationHistory(name,afterGeneration),
      conversation:(name,generation,afterSequence)=>client.call<ConversationContent>('conversation',{name,generation,...(afterSequence===undefined?{}:{afterSequence})}),
    });
    const server=new DashboardServer({backend:new DashboardOperatorClient(config.dispatcher_socket),origin:config.origin,port:config.port,controlSocket:config.control_socket,reader,observer,page:web.observerDashboardPage(),version:manifest.sha});
    try{await server.start();}catch(error){reader.close();throw error;}
    let closing=false;
    const shutdown=async(code:number)=>{if(closing)return;closing=true;cancelWatch();const deadline=setTimeout(()=>process.exit(1),5000);deadline.unref();try{await server.close();}finally{reader.close();process.exit(code);}};
    const cancelWatch=config.active_release_pointer?watchDashboardRelease(config.active_release_pointer,manifest.sha,()=>shutdown(1)):()=>{};
    for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void shutdown(0);});
    return;
  }
  if(command==='pair'&&!process.stdout.isTTY)throw Error('dashboard_pair_requires_terminal');
  const parent=fs.lstatSync(path.dirname(config.control_socket)),socket=fs.lstatSync(config.control_socket),uid=process.getuid?.();
  if(fs.realpathSync(path.dirname(config.control_socket))!==path.dirname(config.control_socket)||!parent.isDirectory()||parent.uid!==uid||(parent.mode&0o777)!==0o700||!socket.isSocket()||socket.uid!==uid||(socket.mode&0o777)!==0o600)throw Error('dashboard_control_unverified');
  const body=command==='pair'?JSON.stringify({capabilities:capabilities.length?capabilities:['tasks:read','conversations:worker:read']}):command==='revoke'?JSON.stringify(deviceId?{device_id:deviceId}:{}):'';
  const result=await new Promise<string>((resolve,reject)=>{
    const request=http.request({socketPath:config.control_socket,path:command==='status'?'/health/version':'/'+command,method:command==='status'?'GET':'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},response=>{
      let raw='';response.setEncoding('utf8');response.on('data',(chunk:string)=>{raw+=chunk;if(Buffer.byteLength(raw)>8192)response.destroy(Error('dashboard_response_limit'));});response.on('error',reject);response.on('end',()=>response.statusCode===200?resolve(raw):reject(Error('dashboard_control_failed')));
    });request.setTimeout(5000,()=>request.destroy(Error('dashboard_control_ambiguous')));request.on('error',reject);request.end(body);
  });
  // Only the explicit local operator command prints a one-use code.
  process.stdout.write(result+'\n');
}
void main().catch(()=>{process.stderr.write('dashboard_operation_failed\n');process.exitCode=1;});
