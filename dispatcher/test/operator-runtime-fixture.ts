import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {serveRuntime} from '../src/app-server/host.js';
import {RuntimeClient} from '../src/app-server/client.js';
import {AppServerAgentClient,AppServerJobRuntime,runtimeSocket} from '../src/app-server/adapters.js';
import {DispatcherDatabase} from '../src/database.js';
import {DispatcherWorker} from '../src/worker.js';
import {JobSupervisor} from '../src/job-supervisor.js';
import {DispatcherApi} from '../src/api.js';
import {DashboardServer} from '../src/dashboard/server.js';
import {DashboardOperatorClient} from '../src/dashboard/operator-client.js';
import {DashboardTaskReader} from '../src/dashboard/task-reader.js';
import {DashboardObserver} from '../src/dashboard/observer.js';
import {tempConfig} from './helpers.js';
const logger={debug(){},info(){},warn(){},error(){}};
async function freePort(){const s=net.createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as net.AddressInfo).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
/** Codexだけを独立JSON-RPC processへ置換。DBとruntimeのmethod/stateは実装を通す。 */
export async function operatorRuntimeFixture(origin:string,page:{status:number;headers:Record<string,string>;body:string}){
 if(process.env.DONA_APP_SERVER_SOCKET)throw Error('fixture_requires_unset_runtime_socket');
 const temporary=await tempConfig(),root=await fs.realpath(temporary.root),config=temporary.config;
 const cleanups:Array<()=>Promise<void>>=[()=>fs.rm(root,{recursive:true,force:true})];
 const cleanup=async()=>{const errors:unknown[]=[];for(const fn of cleanups.splice(0).reverse())try{await fn();}catch(e){errors.push(e);}if(errors.length)throw new AggregateError(errors,'fixture_cleanup_failed');};
 try{
 config.socketPath=path.join(root,'d.sock');config.updaterSocketPath=path.join(root,'u.sock');config.jobCommandTimeoutMs=5000;config.jobAgentStartTimeoutMs=5000;config.jobPromptTimeoutMs=5000;config.agentWaitTimeoutMs=200;
 const finish=path.join(root,'finish'),calls=path.join(root,'rpc-calls'),script=path.join(root,'codex-fixture.mjs');config.codexPath=script;
 await fs.writeFile(script,`#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {WebSocketServer} from ${JSON.stringify(new URL('../node_modules/ws/wrapper.mjs',import.meta.url).href)};
if(process.argv.includes('mcp')){process.stdout.write('[]');process.exit(0);}
const root=${JSON.stringify(root)},finish=${JSON.stringify(finish)},calls=${JSON.stringify(calls)},thread='thread_'+process.pid;let turn=0,items=[],working=false;
const atomic=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});if(!path.join(fs.realpathSync(path.dirname(file)),path.basename(file)).startsWith(root+path.sep))throw Error('outside_fixture');if(fs.existsSync(file))throw Error('result_exists');fs.writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(file+'.tmp',file);};
const server=http.createServer(),ws=new WebSocketServer({server}),socket=process.argv[process.argv.indexOf('--listen')+1].slice(7);
ws.on('connection',client=>client.on('message',raw=>{const r=JSON.parse(raw),send=v=>client.send(JSON.stringify(v));fs.appendFileSync(calls,JSON.stringify({method:r.method,pid:process.pid})+'\\n');
 if(r.method==='initialize')send({id:r.id,result:{}});
 else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{thread:{id:thread}}});
 else if(r.method==='thread/read')send({id:r.id,result:{thread:{id:thread,status:{type:working?'active':'idle'}}}});
 else if(r.method==='thread/turns/list')send({id:r.id,result:{data:turn?[{id:'turn_'+turn,items}]:[],nextCursor:null}});
 else if(r.method==='turn/start'){
  turn++;working=true;const turnId='turn_'+turn,text=r.params.input[0].text;send({id:r.id,result:{turn:{id:turnId}}});send({method:'turn/started',params:{threadId:thread,turn:{id:turnId}}});
  const job=text.match(/\\[DONA_JOB_BEGIN\\]\\njob_json:\\n([^\\n]+)\\n/);
  const done=()=>{working=false;send({method:'turn/completed',params:{threadId:thread,turn:{id:turnId,status:'completed'}}});};
  if(job){const j=JSON.parse(job[1]);items=[{id:'progress',type:'agentMessage',text:'隔離ワーカーが実行中です'}];send({method:'item/completed',params:{threadId:thread,turnId,item:items[0]}});
   const timer=setInterval(()=>{if(!fs.existsSync(finish))return;clearInterval(timer);atomic(j.result_path,{schema_version:1,job_id:j.job_id,status:'completed',summary:'隔離ワーカーが完了しました',output:{format:'markdown',text:'保存された最終成果'},artifacts:[],actions:[],completed_at:new Date().toISOString()});items=[{id:'result',type:'agentMessage',text:'隔離ワーカーが完了しました'}];send({method:'item/completed',params:{threadId:thread,turnId,item:items[0]}});done();},20);
  }else{const id=text.match(/event_id: ([^\\n]+)/)?.[1],file=text.match(/result_path: ([^\\n]+)/)?.[1];if(id&&file)atomic(file,{schema_version:1,event_id:id,status:'completed',summary:'隔離通知を処理しました',actions:[],memory_candidates:[],completed_at:new Date().toISOString()});done();}
 }
}));server.listen(socket,()=>fs.chmodSync(socket,0o600));
`,{mode:0o700});
 const host=await serveRuntime({socket:runtimeSocket(config),database:path.join(root,'runtime.db'),codex:script,buildSha:'fixture'}),client=new RuntimeClient(runtimeSocket(config));
 cleanups.push(async()=>{for(const agent of await client.list())if(agent.state!=='stopped')await client.stop(agent.name,agent.generation);host.closeAllConnections();await new Promise<void>(r=>host.close(()=>r()));});
 await client.start({name:config.agentName,role:'main',cwd:root,release:root,args:[],threadConfig:{}});
 const db=new DispatcherDatabase(config.databasePath),reader=new DashboardTaskReader(config.databasePath);cleanups.push(async()=>{reader.close();db.close();});
 let worker:DispatcherWorker;
 const runtime=new AppServerJobRuntime(config,false,id=>db.getJobLiveSessionIdentity(id)?.herdr_agent_session_id??undefined,id=>!!db.tasks.forAttempt(id),id=>db.hasLocalDashboardJobOwner(id));
 const supervisor=new JobSupervisor(db,runtime,config,logger,()=>worker?.wake());
 worker=new DispatcherWorker(db,new AppServerAgentClient(runtimeSocket(config),config.agentName,config.agentWaitTimeoutMs),config,logger,undefined,()=>supervisor.wake());
 cleanups.push(async()=>{await worker.stop();await supervisor.stop();});
 const api=new DispatcherApi(db,worker,supervisor,config,logger);await api.start();cleanups.push(()=>api.stop());worker.start();supervisor.start();
 const port=await freePort(),control=path.join(root,'b.sock'),backend=new DashboardOperatorClient(config.socketPath);
 const observer=new DashboardObserver(reader,{conversations:after=>client.conversations(after),conversationHistory:(name,after)=>client.conversationHistory(name,after),conversation:(name,generation,after)=>client.conversation(name,generation,after)});
 const bff=new DashboardServer({backend,origin,port,controlSocket:control,version:'fixture',reader,observer,page});await bff.start();cleanups.push(()=>bff.close());
 return {db,config,port,client,worker,supervisor,async pairCode(){const v=await backend.call<{code:string}>('admin/pair',{capabilities:['tasks:read','conversations:worker:read','conversations:main:read','tasks:submit','tasks:cancel']});return v.code;},async finish(){await fs.writeFile(finish,'finish');},async calls(){return (await fs.readFile(calls,'utf8')).trim().split('\n').map(v=>JSON.parse(v) as {method:string;pid:number});},close:cleanup};
 }catch(error){await cleanup();throw error;}
}
