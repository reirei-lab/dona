import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DispatcherApi} from '../dispatcher/src/api.js';
import {DispatcherDatabase} from '../dispatcher/src/database.js';
import {DashboardServer} from '../dispatcher/src/dashboard/server.js';
import {DashboardOperatorClient} from '../dispatcher/src/dashboard/operator-client.js';
import {DashboardTaskReader} from '../dispatcher/src/dashboard/task-reader.js';
import {DashboardObserver} from '../dispatcher/src/dashboard/observer.js';
import {taskRequestSchema} from '../dispatcher/src/task-execution.js';
import {tempConfig,eventEnvelope} from '../dispatcher/test/helpers.js';
async function freePort(){const server=net.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
async function request(port:number,socket:string|null,target:string,body?:unknown,cookie?:string){
 const raw=body===undefined?'':JSON.stringify(body);
 return new Promise<{status:number;body:Record<string,unknown>;cookie:string|undefined}>((resolve,reject)=>{
  const req=http.request({...socket?{socketPath:socket}:{hostname:'127.0.0.1',port},path:target,method:body===undefined?'GET':'POST',headers:{host:'dona.example.test',origin:'https://dona.example.test',...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(raw)})}},res=>{
   let content='';res.setEncoding('utf8');res.on('data',chunk=>content+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(content),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}));
  });req.setTimeout(5000,()=>req.destroy(Error('fixture_timeout')));req.on('error',reject);req.end(raw);
 });
}
test('実Dispatcher private APIとBFFの認可・origin reset・失効・再起動はworker継続を保つ',{timeout:20000},async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),reader=new DashboardTaskReader(config.databasePath);let bff:DashboardServer|undefined;
 config.socketPath=path.join(await fs.realpath(root),'d.sock');
 let controls=0;const logger={debug(){},info(){},warn(){},error(){}};
 const api=new DispatcherApi(db,{isRunning:()=>true,wake(){controls++;}},{isRunning:()=>true,wake(){controls++;},async steer(){controls++;throw Error('forbidden');},async cancel(){controls++;throw Error('forbidden');}},config,logger);
 const worker=spawn(process.execPath,['-e','setInterval(()=>process.stdout.write("alive\\n"),50)'],{stdio:['ignore','pipe','ignore']});
 try{
  const event=db.enqueue(eventEnvelope('operator-service')).row;
  const task=db.tasks.create(taskRequestSchema.parse({source_event_id:event.event_id,task_key:'operator-observation',objective:'fixture',workspace:{kind:'scratch'}}),config.jobsWorkspaceRoot,config.jobResultsDir).task;
  const before=db.tasks.get(task.task_id);await api.start();await once(worker.stdout!,'data');
  const port=await freePort(),control=path.join(await fs.realpath(path.dirname(config.socketPath)),'b.sock'),backend=new DashboardOperatorClient(config.socketPath);
  const observer=new DashboardObserver(reader,{async conversations(){return{items:[],next:null};},async conversation(){throw Error('no runtime for queued task');}});
  const options={backend,origin:'https://dona.example.test',port,controlSocket:control,version:'fixture',reader,observer,page:{status:200,headers:{},body:'fixture'}};
  bff=new DashboardServer(options);await bff.start();assert.ok(db.operatorWebAuthn);
  const pair=async()=>{const issued=await request(port,control,'/pair',{capabilities:['tasks:read','conversations:worker:read']});assert.equal(issued.status,200);const response=await request(port,null,'/api/pair',{code:issued.body.code});assert.equal(response.status,200);return response.cookie!;};
  let cookie=await pair();assert.equal((await request(port,null,'/api/tasks',undefined,cookie)).status,200);
  const session=await request(port,null,'/api/session',undefined,cookie);assert.deepEqual(session.body.capabilities,['conversations:worker:read','tasks:read']);
  assert.equal((await request(port,control,'/revoke',{device_id:session.body.device_id})).status,200);assert.equal((await request(port,null,'/api/tasks',undefined,cookie)).status,401);
  cookie=await pair();await bff.close();assert.equal(worker.exitCode,null);await once(worker.stdout!,'data');
  bff=new DashboardServer(options);await bff.start();assert.equal((await request(port,null,'/api/tasks',undefined,cookie)).status,401);
  cookie=await pair();assert.equal((await request(port,null,`/api/tasks/${task.task_id}`,undefined,cookie)).status,200);
  assert.equal(controls,0);assert.deepEqual(db.tasks.get(task.task_id),before);assert.equal(worker.exitCode,null);
 }finally{await bff?.close();await api.stop();const done=once(worker,'exit');worker.kill();await done;reader.close();db.close();await fs.rm(root,{recursive:true,force:true});}
});
