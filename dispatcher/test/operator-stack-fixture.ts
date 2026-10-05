import Database from 'better-sqlite3';
import {OperatorWebAuthn} from '../src/dashboard/operator-webauthn.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {DispatcherApi} from '../src/api.js';
import {DispatcherDatabase} from '../src/database.js';
import {DashboardServer} from '../src/dashboard/server.js';
import {DashboardOperatorClient} from '../src/dashboard/operator-client.js';
import {DashboardTaskReader} from '../src/dashboard/task-reader.js';
import {DashboardObserver} from '../src/dashboard/observer.js';
import {JobSupervisor} from '../src/job-supervisor.js';
import {AppServerJobRuntime,runtimeSocket} from '../src/app-server/adapters.js';
import {tempConfig} from './helpers.js';
import type {QuestionRecord} from '../src/app-server/store.js';
const logger={debug(){},info(){},warn(){},error(){}};
async function freePort(){const server=net.createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
interface Response {status:number;body:any;cookie?:string}
export async function operatorStackFixture(options:{origin?:string;page?:{status:number;headers:Record<string,string>;body:string}}={}){
 const origin=options.origin??"https://dona.example.test";
 if(process.env.DONA_APP_SERVER_SOCKET)throw Error("fixture_requires_unset_runtime_socket");
 const {root,config}=await tempConfig(),real=await fs.realpath(root);config.socketPath=path.join(real,'d.sock');config.updaterSocketPath=path.join(real,'u.sock');
 const db=new DispatcherDatabase(config.databasePath),reader=new DashboardTaskReader(config.databasePath),questions=new Map<string,QuestionRecord[]>();let readGate:(()=>Promise<void>)|undefined;const writes:Array<{action:string;id:string;accepted?:boolean}>=[];
 const runtime=http.createServer(async(req,res)=>{try{let text='';for await(const chunk of req)text+=String(chunk);const input=JSON.parse(text);let result:unknown;
  if(input.action==='questions'){await readGate?.();result=questions.get(input.name)??[];}
  else if(['answer','approve'].includes(input.action)){const q=(questions.get(input.name)??[]).find(q=>q.question_id===input.id);if(!q)throw Error('unknown_question');writes.push({action:input.action,id:input.id,...(input.action==='approve'?{accepted:input.accepted}:{})});q.state='resolved';result=q;}
  else throw Error('runtime_mutation_not_allowed');res.setHeader('content-type','application/json');res.end(JSON.stringify({result}));
 }catch{res.writeHead(400);res.end('{"error":"fixture_rejected"}');}});
 await new Promise<void>(r=>runtime.listen(runtimeSocket(config),r));
 const supervisor=new JobSupervisor(db,new AppServerJobRuntime(config,false,id=>db.getJobLiveSessionIdentity(id)?.herdr_agent_session_id??undefined,id=>!!db.tasks.forAttempt(id),id=>db.hasLocalDashboardJobOwner(id)),config,logger,()=>{});
 const api=new DispatcherApi(db,{isRunning:()=>true,wake(){}},supervisor,config,logger);await api.start();
 const port=await freePort(),control=path.join(real,'b.sock');const observer=new DashboardObserver(reader,{async conversations(){return{items:[],next:null};},async conversation(){throw Error('not observed');}});
 const bff=new DashboardServer({backend:new DashboardOperatorClient(config.socketPath),origin,port,controlSocket:control,version:'fixture',reader,observer,page:options.page??{status:200,headers:{},body:'fixture'}});await bff.start();
 async function request(target:string,options:{body?:unknown;raw?:string;cookie?:string;csrf?:string;control?:boolean;dispatcher?:boolean;origin?:string;loseResponse?:boolean}={}):Promise<Response>{
  const raw=options.raw??(options.body===undefined?'':JSON.stringify(options.body)),post=options.body!==undefined||options.raw!==undefined;
  return new Promise((resolve,reject)=>{const req=http.request({...options.dispatcher?{socketPath:config.socketPath}:options.control?{socketPath:control}:{hostname:'127.0.0.1',port},path:target,method:post?'POST':'GET',headers:{host:new URL(origin).host,origin:options.origin??origin,...options.cookie?{cookie:options.cookie}:{},...options.csrf?{'x-csrf-token':options.csrf}:{},...post?{'content-type':'application/json','content-length':Buffer.byteLength(raw)}:{}}},res=>{
   if(options.loseResponse){res.destroy();resolve({status:0,body:null});return;}
   let content='';res.setEncoding('utf8');res.on('data',chunk=>content+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(content),...res.headers['set-cookie']?.[0]?{cookie:res.headers['set-cookie'][0].split(';')[0]!}:{}}));
  });req.setTimeout(5000,()=>req.destroy(Error('fixture_timeout')));req.on('error',reject);req.end(raw);});
 }
 const issued=await request('/pair',{control:true,body:{capabilities:['tasks:read','tasks:submit','tasks:cancel','approvals:native']}});assert.equal(issued.status,200);
 const paired=await request('/api/pair',{body:{code:issued.body.code}});assert.equal(paired.status,200);const cookie=paired.cookie!;
 const session=await request('/api/session',{cookie});assert.equal(session.status,200);const csrf=session.body.csrf as string;
 function startQuestion(taskId:string,kind:'question'|'approval',questionId:string){const task=db.tasks.get(taskId)!,job=db.getJob(task.current_attempt_id)!;db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,'w','p',JSON.stringify(['g','t']));db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
  const q:QuestionRecord={question_id:questionId,agent:job.agent_name,generation:'g',thread_id:'t',turn_id:'turn',rpc_id_json:'1',kind,payload_json:JSON.stringify(kind==='approval'?{command:'echo fixture'}:{questions:[{id:'scope',question:'何を調べますか？'}]}),state:'pending',answer_hash:null,created_at:new Date().toISOString()};questions.set(job.agent_name,[q]);db.enqueueWorkerQuestion(job.job_id,q);return{task:db.tasks.get(taskId)!,job,q};}
 return {db,config,port,request,setExternalApproval:api.setExternalApproval.bind(api),cookie,csrf,session,supervisor,writes,startQuestion,setReadGate:(gate?:()=>Promise<void>)=>{readGate=gate;},async close(){await bff.close();await api.stop();runtime.closeAllConnections();await new Promise<void>(r=>runtime.close(()=>r()));reader.close();db.close();await fs.rm(root,{recursive:true,force:true});}};
}


export function fixtureWebAuthnClock(db:DispatcherDatabase,filename:string,origin:string,wall:()=>number){const sql=new Database(filename);db.operatorWebAuthn=new OperatorWebAuthn(sql,db.operatorAuth,origin,()=>performance.now(),wall);return ()=>sql.close();}
