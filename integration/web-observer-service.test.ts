import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {DispatcherDatabase} from '../dispatcher/src/database.js';
import {taskRequestSchema} from '../dispatcher/src/task-execution.js';
import {eventEnvelope} from '../dispatcher/test/helpers.js';
const run=promisify(execFile),repo=fileURLToPath(new URL('../',import.meta.url));
async function request(port:number,socket:string|null,target:string,options:{post?:boolean;body?:unknown;cookie?:string}={}){
 return new Promise<{status:number;body:string;cookie?:string}>((resolve,reject)=>{
  const body=options.body===undefined?'':JSON.stringify(options.body);
  const req=http.request({...socket?{socketPath:socket}:{host:'127.0.0.1',port},path:target,method:options.post?'POST':'GET',headers:{host:'observer.example',origin:'https://observer.example',...(options.cookie?{cookie:options.cookie}:{}),...(options.post?{'content-type':'application/json','content-length':Buffer.byteLength(body)}:{})}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:text,...res.headers['set-cookie']?.[0]?{cookie:res.headers['set-cookie'][0].split(';')[0]!}:{}}));
  });req.setTimeout(2000,()=>req.destroy(Error('fixture_request_timeout')));req.on('error',reject);req.end(body);
 });
}
async function until<T>(operation:()=>Promise<T|false>):Promise<T>{const end=Date.now()+10000;while(Date.now()<end){try{const value=await operation();if(value!==false)return value;}catch{}await new Promise(r=>setTimeout(r,25));}throw Error('fixture_wait_timeout');}
async function port(){const s=net.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address()as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
async function deadline<T>(value:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([value,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture_process_timeout')),10000);})]);}finally{clearTimeout(timer);}}
async function exit(child:ChildProcess,signal:NodeJS.Signals='SIGTERM'){if(child.exitCode!==null||child.signalCode!==null)return;const done=once(child,'exit');child.kill(signal);await deadline(done);}

test('実CLIはpairing・観測・SIGKILL回復・preserve更新・rollbackでworkerとDBを保全する',{timeout:90000},async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dobs-cli-'))),runtimeSocket=path.join(root,'r.sock'),control=path.join(root,'c.sock');
 const db=new DispatcherDatabase(path.join(root,'d.sqlite3')),calls:string[]=[];let process:ChildProcess|undefined;let runtime:http.Server|undefined;let worker:ChildProcess|undefined;
 try{
  const event=db.enqueue(eventEnvelope('observer-service-cli')).row;
  const created=db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:'cli-observation',objective:'private objective',workspace:{kind:'scratch'}}),path.join(root,'work'),path.join(root,'results'));
  const before=JSON.stringify(db.tasks.get(created.task.task_id)),attempt=created.task.current_attempt_id;
  const agent=db.getJob(attempt)!.agent_name;
  const a='a'.repeat(40),b='b'.repeat(40),runtimeRoot=path.join(root,'runtime'),releaseA=path.join(runtimeRoot,'releases',a),releaseB=path.join(runtimeRoot,'releases',b),pointer=path.join(runtimeRoot,'current');
  await fs.mkdir(releaseA,{recursive:true,mode:0o700});await fs.chmod(runtimeRoot,0o700);
  await run(globalThis.process.execPath,[path.join(repo,'dispatcher/node_modules/typescript/bin/tsc'),'-p',path.join(repo,'dispatcher/tsconfig.build.json'),'--outDir',path.join(releaseA,'dispatcher/dist')],{timeout:30000,maxBuffer:1024*1024});
  await run(globalThis.process.execPath,[path.join(repo,'sources/web/node_modules/typescript/bin/tsc'),'-p',path.join(repo,'sources/web/tsconfig.build.json'),'--outDir',path.join(releaseA,'sources/web/dist')],{timeout:30000,maxBuffer:1024*1024});
  await fs.writeFile(path.join(releaseA,'package.json'),'{"type":"module"}');await fs.symlink(path.join(repo,'dispatcher/node_modules'),path.join(releaseA,'dispatcher/node_modules'));
  const manifest=(sha:string)=>JSON.stringify({sha,lock_hashes:{'sources/web':'c'.repeat(64)}});
  await fs.writeFile(path.join(releaseA,'release-manifest.json'),manifest(a));await fs.cp(releaseA,releaseB,{recursive:true});await fs.writeFile(path.join(releaseB,'release-manifest.json'),manifest(b));await fs.symlink(releaseA,pointer);
  const listen=await port(),config=path.join(root,'config.json');await fs.writeFile(config,JSON.stringify({schema_version:1,origin:'https://observer.example',port:listen,control_socket:control,dispatcher_database:path.join(root,'d.sqlite3'),runtime_socket:runtimeSocket,active_release_pointer:pointer}),{mode:0o600});
  runtime=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=String(chunk);const input=JSON.parse(raw)as{action:string};calls.push(input.action);
   const record={name:agent,generation:'g1',role:'worker',thread_id:'thread-1',attempt_id:attempt,connected:true,observed_at:new Date().toISOString(),state:'working'};
   const result=input.action==='conversations'?{items:[record],next:null}:{...record,items:[{id:'i1',turn_id:'t1',kind:'assistant_message',text:'fixture worker progress'}],events:[],cursor:0,oldest_sequence:0,gap:false,truncated:false};
   res.setHeader('content-type','application/json');res.end(JSON.stringify({result}));});await new Promise<void>(r=>runtime!.listen(runtimeSocket,r));
  worker=spawn(globalThis.process.execPath,['-e',"setInterval(()=>process.stdout.write('alive\\n'),20)"],{stdio:['ignore','pipe','ignore']});await once(worker.stdout!,'data');
  const start=async(sha:string)=>{
   process=spawn(globalThis.process.execPath,[path.join(pointer,'dispatcher/dist/dashboard/cli.js'),'serve',config],{stdio:['ignore','pipe','pipe']});
   await until(async()=>{if(process!.exitCode!==null)throw Error('fixture_child_exited');const result=await request(listen,control,'/health/version');return result.status===200&&JSON.parse(result.body).version===sha;});
  };
  const pair=async()=>{const issued=await request(listen,control,'/pair',{post:true});const login=await request(listen,null,'/api/pair',{post:true,body:{code:JSON.parse(issued.body).code}});assert.equal(login.status,200);assert.ok(login.cookie);return login.cookie!;};
  await start(a);const status=await run(globalThis.process.execPath,[path.join(pointer,'dispatcher/dist/dashboard/cli.js'),'status',config]);assert.equal(JSON.parse(status.stdout).version,a);
  await assert.rejects(run(globalThis.process.execPath,[path.join(pointer,'dispatcher/dist/dashboard/cli.js'),'pair',config]));
  assert.equal((await request(listen,null,'/api/tasks')).status,401);let cookie=await pair();
  assert.equal((await request(listen,null,'/api/tasks',{cookie})).status,200);
  const detail=await request(listen,null,'/api/tasks/'+created.task.task_id,{cookie});assert.equal(detail.status,200);assert.match(detail.body,/fixture worker progress/);
  assert.ok(calls.length>=2);assert.ok(calls.every(action=>['conversations','conversation'].includes(action)));
  await run(globalThis.process.execPath,[path.join(pointer,'dispatcher/dist/dashboard/cli.js'),'revoke',config]);assert.equal((await request(listen,null,'/api/tasks',{cookie})).status,401);cookie=await pair();
  // Hard death leaves a stale UDS; the real service proves it is refused before reclaim.
  await exit(process!,'SIGKILL');await start(a);assert.equal((await request(listen,null,'/api/tasks',{cookie})).status,401);
  for(const [sha,target]of [[b,releaseB],[a,releaseA]]as const){
   cookie=await pair();const ended=once(process!,'exit');await fs.symlink(target,pointer+'.tmp');await fs.rename(pointer+'.tmp',pointer);const [code]=await deadline(ended);assert.equal(code,1);
   assert.equal(worker.exitCode,null);await once(worker.stdout!,'data');await start(sha);assert.equal((await request(listen,null,'/api/tasks',{cookie})).status,401);
  }
  assert.equal(JSON.stringify(db.tasks.get(created.task.task_id)),before);assert.equal(worker.exitCode,null);assert.ok(calls.every(action=>['conversations','conversation'].includes(action)));
 }finally{if(process)await exit(process);if(worker)await exit(worker);if(runtime)await new Promise<void>(r=>runtime!.close(()=>r()));db.close();await fs.rm(root,{recursive:true,force:true});}
});
