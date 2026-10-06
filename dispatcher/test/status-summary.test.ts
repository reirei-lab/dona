import { projectCompletionJob } from "../src/completion-projection.js";
import { AgentReadAuthorization, type AgentReadOwnerBinding } from "../src/agent-read-authorization.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { verifySlackPrincipalProof } from "../src/principal-proof.js";
import { DispatcherApi } from "../src/api.js";
import { AgentContextManager } from "../src/agent-context.js";
import { DispatcherDatabase } from "../src/database.js";
import { DispatcherApiClient } from "../src/client.js";
import { createDispatcherMcpServer } from "../src/mcp/server.js";
import { taskRequestSchema } from "../src/task-execution.js";
import { StatusSummaryService, statusNotAvailable, projectStatusSummary } from "../src/status-summary.js";
import { signSlackPrincipalProof } from "../../sources/slack/src/principal-proof.js";
import { DispatcherClient } from "../../sources/slack/src/dispatcher-client.js";
import { eventEnvelope, tempConfig } from "./helpers.js";
const logger={debug(){},info(){},warn(){},error(){}};
const canary="SECRET_STATUS_CANARY";
const worker={isRunning:()=>true,wake(){},async steer(){throw Error("not used");},async cancel(){throw Error("not used");}};
async function fixture(ownerActor="U_TEST") {
 const {root,config}=await tempConfig();const db=new DispatcherDatabase(config.databasePath);
 await fs.mkdir(path.dirname(config.updateInternalTokenPath),{recursive:true});await fs.writeFile(config.updateInternalTokenPath,"test-secret-key-00000000000000000000",{mode:0o600});
 const logs:unknown[]=[];const captured={debug(...v:unknown[]){logs.push(v);},info(...v:unknown[]){logs.push(v);},warn(...v:unknown[]){logs.push(v);},error(...v:unknown[]){logs.push(v);}};
 const contexts=new AgentContextManager(db,path.join(path.dirname(config.socketPath),"status-context.json"));await contexts.initialize();
 let authorized=true,destinationKind="public_channel",calls=0,afterMembership:undefined|(()=>void);
 const membership=http.createServer(async(req,res)=>{let text="";for await(const chunk of req)text+=chunk;
  assert.equal(req.headers["x-dona-update-token"],"test-secret-key-00000000000000000000");const input=JSON.parse(text);assert.equal(input.status_summary,true);calls++;afterMembership?.();
  res.end(JSON.stringify({...input,authorized:authorized&&input.user_id!=="U_BOT",destination_kind:destinationKind,channel_kind:"other",channel_user_id:null}));});
 await fs.mkdir(path.dirname(config.slackAdapterSocketPath),{recursive:true});await new Promise<void>(r=>membership.listen(config.slackAdapterSocketPath,r));
 const api=new DispatcherApi(db,worker,worker,config,captured,undefined,undefined,undefined,undefined,undefined,undefined,undefined,contexts);await api.start();
 const ingress=new DispatcherClient({socketPath:config.socketPath,connectTimeoutMs:1000,timeoutMs:1000,internalTokenPath:config.updateInternalTokenPath});
 async function event(name:string,actor=ownerActor,channel="C_TEST",workspace="T_TEST",thread="1756722031.123456") {
  const env=eventEnvelope(name);env.trace={status_origin_visibility:"public_channel"};env.subject={...env.subject,actor_id:actor,workspace_id:workspace,channel_id:channel,thread_ts:thread};
  env.reply_target={kind:"slack_thread",workspace_id:workspace,channel_id:channel,thread_ts:thread};
  const response=await ingress.postEvent(env,workspace);if(response.statusCode!==202) { process.stderr.write(response.body); await api.stop(); await new Promise<void>(r=>membership.close(()=>r()));db.close(); }
  assert.equal(response.statusCode,202);return db.get(JSON.parse(response.body).event_id)!;
 }
 const origin=await event("origin",ownerActor,"C_TEST","T_TEST","1756722030.123456"),request=taskRequestSchema.parse({source_event_id:origin.event_id,task_key:"status",objective:canary,workspace:{kind:"scratch"},policy:{max_attempts:3,retry_delay_ms:1000}});
 const task=db.tasks.create(request,config.jobsWorkspaceRoot,config.jobResultsDir).task,jobId=task.current_attempt_id;
 const sql=new Database(config.databasePath);sql.prepare("UPDATE jobs SET last_error_code=?,last_error_message=?,result_json=?,job_key=? WHERE job_id=?").run(canary,canary,JSON.stringify({schema_version:1,job_id:jobId,status:"completed",summary:canary,output:{format:"markdown",text:"先行完了の成果"},artifacts:[{kind:"report",reference:"成果参照"}],actions:[{secret:canary}],completed_at:new Date().toISOString(),title:canary}),canary,jobId);sql.close();
 const client=new DispatcherApiClient(config.socketPath),server=createDispatcherMcpServer(client,logger),mcp=new Client({name:"status-test",version:"1"});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await mcp.connect(b);
 async function current(row:Awaited<ReturnType<typeof event>>) {const existing=db.get(row.event_id)!;const active=existing.status==="queued"?db.beginDispatch(row.event_id,path.join(root,`${row.event_id}.json`)):existing;return contexts.issue(active);}
 async function query(mode:"api"|"mcp",id=jobId) {const result=mode==="api"?await client.getJobStatusSummary(id):await mcp.callTool({name:"get_job_status_summary",arguments:{job_id:id}});
  const value=mode==="api"?result:JSON.parse(((result as {content:{text:string}[]}).content[0]!).text);
  assert.ok(!JSON.stringify(result).includes(canary));assert.ok(!JSON.stringify(logs).includes(canary));return value;}
 return {root,config,db,contexts,event,current,query,client,mcp,jobId,origin,task,setAccess(v:boolean){authorized=v;},calls:()=>calls,setKind(kind:string){destinationKind=kind;},async stopProvider(){await new Promise<void>(r=>membership.close(()=>r()));},setAfter(v:()=>void){afterMembership=v;},async close(){await mcp.close();await server.close();await api.stop();await new Promise<void>(r=>membership.close(()=>r()));db.close();await fs.rm(root,{recursive:true,force:true});}};
}
for(const mode of ["api","mcp"] as const)test(`${mode}: same requesterの別thread、全拒否matrix、秘密canary、再認可`,async()=>{
 const f=await fixture();try {
  const row=await f.event(`request-${mode}`);await f.current(row);
  const first=await f.query(mode);assert.equal(first.job_id,f.jobId);assert.equal(first.status,"queued");
  assert.deepEqual(Object.keys(first).sort(),["schema_version","job_id","status","observed_at","revision","message"].sort());
  assert.match(first.revision,/^[a-f0-9]{64}$/);assert.ok(Math.abs(Date.now()-Date.parse(first.observed_at))<2000);
  assert.equal((await f.query(mode)).revision,first.revision);assert.equal(f.calls(),2);
  f.setAccess(false);assert.deepEqual(await f.query(mode),statusNotAvailable);f.setAccess(true);
  f.setKind("private_channel");assert.deepEqual(await f.query(mode),statusNotAvailable);f.setKind("public_channel");
  for(const [actor,channel,workspace] of [["U_OTHER","C_TEST","T_TEST"],["U_TEST","C_OTHER","T_TEST"],["U_TEST","C_TEST","T_OTHER"]]) {
   await f.current(await f.event(`deny-${actor}-${channel}-${workspace}`,actor,channel,workspace));assert.deepEqual(await f.query(mode),statusNotAvailable);
  }
  await f.current(row);assert.deepEqual(await f.query(mode,"job_00000000000000000000000000"),statusNotAvailable);
  await f.contexts.initialize();assert.deepEqual(await f.query(mode),statusNotAvailable);
  await f.current(row);f.setAccess(false);assert.deepEqual(await f.query(mode),statusNotAvailable);
  f.setAccess(true);await f.stopProvider();assert.deepEqual(await f.query(mode),statusNotAvailable);
 }finally{await f.close();}
});
test("status: transport偽造・旧API/Task Attempt raw fallback・TOCTOU・restartを拒否",async()=>{
 const f=await fixture();try {
  const row=await f.event("current");await f.current(row);
  assert.equal((await f.query("api")).status,"queued");
  assert.deepEqual(await f.client.getJob(f.jobId,row.event_id),statusNotAvailable);
  assert.deepEqual(await f.client.listEventJobs(f.origin.event_id),statusNotAvailable);
  assert.deepEqual(await f.client.listThreadJobs("T_TEST","C_TEST","origin"),statusNotAvailable);
  const context=await f.current(row);
  const credential=JSON.parse(await fs.readFile(path.join(path.dirname(f.config.socketPath),"status-context.json"),"utf8"));
  assert.equal(f.contexts.authorize(credential.token,row.event_id,"get_job_status_summary",new Date(0)),undefined);
  assert.equal(f.contexts.authorize(credential.token,row.event_id,"get_job_status_summary",new Date(context.expires_at)),undefined);
  const service=new StatusSummaryService(f.db,async input=>({...input,authorized:true,destination_kind:"public_channel"}));
  for(const purpose of ["job_completion","schedule_work","update_completion"] as const)
   assert.deepEqual(await service.read(f.jobId,{...context,purpose},()=>({...context,purpose})),statusNotAvailable);
  f.setAfter(()=>{f.db.markJobNeedsReview(f.jobId,"unknown",canary);});assert.deepEqual(await f.query("api"),statusNotAvailable);
  f.setAfter(()=>{});const next=await f.query("api");assert.equal(next.status,"needs_review");
  const reopened=new DispatcherDatabase(f.config.databasePath);const manager=new AgentContextManager(reopened,path.join(f.root,"new-credential.json"));await manager.initialize();
  assert.equal(manager.authorize("old","evt_fake","get_job_status_summary"),undefined);
  const fresh=await manager.issue(reopened.get(row.event_id)!);let checked=0;
  const service2=new StatusSummaryService(reopened,async input=>{checked++;return {...input,authorized:false,destination_kind:"public_channel"};});
  assert.deepEqual(await service2.read(f.jobId,fresh,()=>fresh),statusNotAvailable);assert.equal(checked,1);
  reopened.close();
 }finally{await f.close();}
});
test("principal proof: 改竄・期限切れ・replay・未署名ownerは許可されない",async()=>{
 const f=await fixture();try {
  const env=eventEnvelope("unsigned"),row=f.db.enqueue(env).row;const active=f.db.beginDispatch(row.event_id,path.join(f.root,"unsigned.json"));
  await assert.rejects(f.contexts.issue(active));
  const signed=signSlackPrincipalProof({...env,trace:{ingress_attempt:1}},1,"T_TEST","key");assert.ok(signed.proof);
  const proofEnvelope={...env,trace:{ingress_attempt:1}};
  assert.throws(()=>verifySlackPrincipalProof(proofEnvelope,signed.proof,"forged","key"));
  assert.throws(()=>verifySlackPrincipalProof({...proofEnvelope,subject:{...env.subject,channel_id:"C_OTHER"}},signed.proof,signed.signature,"key"));
  assert.throws(()=>verifySlackPrincipalProof(proofEnvelope,signed.proof,signed.signature,"key",new Date(Date.now()+121000)));
  const proof=verifySlackPrincipalProof(proofEnvelope,signed.proof,signed.signature,"key");
  f.db.enqueue(proofEnvelope,new Date(),proof);
  assert.throws(()=>f.db.enqueue(proofEnvelope,new Date(),proof),/principal binding conflicts/);
  await f.current(await f.event("good"));await fs.writeFile(path.join(path.dirname(f.config.socketPath),"status-context.json"),JSON.stringify({event_id:row.event_id,token:"forged"}));
  assert.deepEqual(await f.query("api"),statusNotAvailable);
 }finally{await f.close();}
});

for(const mode of ["api","mcp"] as const)test(`${mode}: bot owner、schedule/unknown contextも同一not_available`,async()=>{
 const f=await fixture("U_BOT");try {await f.current(await f.event(`bot-${mode}`));assert.deepEqual(await f.query(mode),statusNotAvailable);
  await f.contexts.initialize();assert.deepEqual(await f.query(mode),statusNotAvailable);
 }finally{await f.close();}
 const human=await fixture();try {const row=await human.event(`schedule-${mode}`);await human.current(row);
  await human.contexts.issue({...human.db.get(row.event_id)!,source:"dona_schedule"});assert.deepEqual(await human.query(mode),statusNotAvailable);
 }finally{await human.close();}
});
test("MCP projectionはproviderの秘密field/messageとunknown statusを流用しない",()=>{
 const value={schema_version:1,job_id:"job_00000000000000000000000000",status:"running",revision:"a".repeat(64),observed_at:new Date().toISOString(),message:canary,result:canary,title:canary};
 assert.ok(!JSON.stringify(projectStatusSummary(value)).includes(canary));
 assert.deepEqual(projectStatusSummary({...value,status:canary}),statusNotAvailable);
});

test("list_event_jobsはcurrent human/保存されたcompletion purposeだけに固定projectionを許可する",async()=>{
 const f=await fixture();try {
  await f.current(f.origin);
  const own=await f.client.listEventJobs(f.origin.event_id);assert.ok(!JSON.stringify(own).includes(canary));assert.equal((own.jobs as unknown[]).length,1);
  f.db.markWaiting(f.origin.event_id);
  f.db.saveCompleted(f.origin.event_id,{schema_version:1,event_id:f.origin.event_id,status:"completed",summary:"delegated",completed_at:new Date().toISOString()},path.join(f.root,"origin.json"));
  f.db.markJobNeedsReview(f.jobId,"test",canary);
  const notice=f.db.enqueueJobNotification(f.jobId).row;await f.current(notice);
  const completion=await f.client.listEventJobs(f.origin.event_id);assert.equal((completion.jobs as unknown[]).length,1);assert.ok(!JSON.stringify(completion).includes(canary));
  const projected=await f.client.getJob(f.jobId,notice.event_id),result=JSON.parse((projected.job as {result_json:string}).result_json);
  assert.equal(result.summary,canary);assert.equal(result.output.text,"先行完了の成果");assert.deepEqual(result.artifacts,[{kind:"report",reference:"成果参照"}]);assert.deepEqual(result.actions,[]);assert.equal(result.title,undefined);
  const mcp=await f.mcp.callTool({name:"get_job_status",arguments:{job_id:f.jobId,source_event_id:notice.event_id}});
  assert.deepEqual(JSON.parse((mcp.structuredContent as {job:{result_json:string}}).job.result_json),result);
  assert.equal((projected.job as {last_error_message:string}).last_error_message,"[redacted]");
  f.setAccess(false);assert.deepEqual(await f.client.getJob(f.jobId,notice.event_id),statusNotAvailable);f.setAccess(true);
  f.setAfter(()=>{const sql=new Database(f.config.databasePath);sql.prepare("UPDATE events SET reply_target_json=? WHERE event_id=?").run(JSON.stringify({kind:"slack_thread",workspace_id:"T_TEST",channel_id:"C_TEST",thread_ts:"foreign"}),notice.event_id);sql.close();});
  assert.deepEqual(await f.client.getJob(f.jobId,notice.event_id),statusNotAvailable);f.setAfter(()=>{});
  assert.deepEqual(await f.query("api"),statusNotAvailable);
  const unrelated=await f.event("unrelated");assert.deepEqual(await f.client.listEventJobs(unrelated.event_id),statusNotAvailable);
 }finally{await f.close();}
});

test("稼働中socketへの重複起動失敗はcurrent credentialを削除しない",async()=>{
 const f=await fixture();try {
  await f.current(await f.event("active"));assert.equal((await f.query("api")).status,"queued");
  const credentialPath=path.join(path.dirname(f.config.socketPath),"status-context.json"),before=await fs.readFile(credentialPath,"utf8");
  const second=new DispatcherApi(f.db,worker,worker,f.config,logger,undefined,undefined,undefined,undefined,undefined,undefined,undefined,new AgentContextManager(f.db,credentialPath));
  await assert.rejects(second.start(),/Another dispatcher/);await second.stop();
  assert.equal(await fs.readFile(credentialPath,"utf8"),before);assert.equal((await f.query("api")).status,"queued");
 }finally{await f.close();}
});

test("#166共通policyのdefault deny、authority/disclosure分離、scopeとcurrent bindingを維持する",async()=>{
 const f=await fixture();try {
  const context=await f.current(await f.event("policy")),job=f.db.getJob(f.jobId)!;
  const binding:AgentReadOwnerBinding={job_id:job.job_id,source_event_id:job.source_event_id,owner_kind:"human_verified",tenant_id:context.tenant_id,workspace_id:context.workspace_id,principal_kind:"human",principal_id:context.principal_id,resource_kind:"unknown",repository_node_id:null,task_node_id:null,resource_revision:1,policy_revision:1,disclosure_origin_json:"{}"};
  const input={context,job,binding,operation:"read_exact_job_status" as const,surface:"get_job_status_summary" as const,owner_binding_current:true,disclosure_destination:{}};
  const denied=new AgentReadAuthorization().authorize(input);assert.equal(denied.authority.reason,"grant_unavailable");assert.equal(denied.allowed,false);
  const grantOnly=new AgentReadAuthorization({authorize:()=>true}).authorize(input);assert.equal(grantOnly.authority.allowed,true);assert.equal(grantOnly.disclosure.allowed,false);
  const policy=new AgentReadAuthorization({authorize:i=>i.operation==="read_exact_job_status"&&i.surface==="get_job_status_summary"},{authorize:()=>true});
  assert.equal(policy.authorize(input).allowed,true);
  for(const changed of [{...input,binding:{...binding,principal_id:"other"}},{...input,job:{...job,workspace_id:"other"}},{...input,owner_binding_current:false},{...input,binding:{...binding,policy_revision:2}},{...input,operation:"read_bounded_result" as const}])assert.equal(policy.authorize(changed).allowed,false);
  const auditFail=new AgentReadAuthorization({authorize:()=>true},{authorize:()=>true},{record(){throw Error(canary);}}).authorize(input);assert.equal(auditFail.disclosure.reason,"audit_unavailable");assert.ok(!JSON.stringify(auditFail).includes(canary));
 }finally{await f.close();}
});

test("v1 bindingのupgradeは未署名destinationをbackfillせず、Envelope改竄も拒否する",async()=>{
 const f=await fixture();try {
  await f.current(await f.event("upgrade-current"));assert.equal((await f.query("api")).status,"queued");
  const sql=new Database(f.config.databasePath);
  sql.prepare("UPDATE events SET trace_json=? WHERE event_id=?").run(JSON.stringify({ingress_attempt:1,status_origin_visibility:"private_channel"}),f.origin.event_id);
  assert.deepEqual(await f.query("api"),statusNotAvailable);
  sql.exec("ALTER TABLE verified_principal_bindings DROP COLUMN proof_version; ALTER TABLE verified_principal_bindings DROP COLUMN envelope_sha256; UPDATE verified_principal_binding_schema SET version=1");
  sql.close();
  const reopened=new DispatcherDatabase(f.config.databasePath);assert.equal(reopened.getVerifiedPrincipalBinding(f.origin.event_id),undefined);
  const manager=new AgentContextManager(reopened,path.join(f.root,"upgrade-credential.json"));await manager.initialize();
  await assert.rejects(manager.issue(reopened.get(f.origin.event_id)!));reopened.close();
 }finally{await f.close();}
});

test("Taskの後継Attemptを作ってもexact旧jobと現在jobの状態を混同しない",async()=>{
 const f=await fixture();try {
  const sql=new Database(f.config.databasePath);sql.prepare("UPDATE jobs SET result_json=NULL WHERE job_id=?").run(f.jobId);sql.close();
  const evidence={state:"stopped" as const,reason:"isolated fixture",observed_at:new Date().toISOString(),process_ids:[],process_groups:[]};
  const claimed=f.db.tasks.claimStop(f.db.tasks.get(f.task.task_id)!,evidence);
  assert.equal(f.db.tasks.beginStop(claimed),true);f.db.tasks.stopped(claimed,evidence);
  const successor=f.db.tasks.replaceStopped(f.task.task_id,f.config.jobResultsDir)!;
  assert.notEqual(successor.job_id,f.jobId);assert.equal(f.db.tasks.get(f.task.task_id)!.current_attempt_id,successor.job_id);
  await f.current(await f.event("attempt-query"));
  for(const mode of ["api","mcp"] as const) {
   const old=await f.query(mode,f.jobId),current=await f.query(mode,successor.job_id);
   assert.equal(old.job_id,f.jobId);assert.equal(old.status,"cancelled");assert.equal(current.job_id,successor.job_id);assert.equal(current.status,"queued");
  }
  assert.equal(f.db.getJob(f.jobId)!.thread_ts,successor.thread_ts);
 }finally{await f.close();}
});

test("MCPはlive membership providerへの外部依存を宣言する",async()=>{
 const f=await fixture();try {const tools=(await f.mcp.listTools()).tools;for(const name of ["get_job_status_summary","list_event_jobs","get_job_status"])assert.equal(tools.find(t=>t.name===name)!.annotations?.openWorldHint,true,name);assert.equal(tools.find(t=>t.name==="get_job_status_summary")!.annotations?.readOnlyHint,true);}finally{await f.close();}
});

for(const mode of ["api","mcp"] as const)test(`${mode}: all_terminal通知から先行完了siblingを含むResultを集約できる`,async()=>{
 const f=await fixture();try {
  const sibling=f.db.tasks.create(taskRequestSchema.parse({source_event_id:f.origin.event_id,task_key:"sibling",objective:"先行成果",workspace:{kind:"scratch"},policy:{max_attempts:3,retry_delay_ms:1000}}),f.config.jobsWorkspaceRoot,f.config.jobResultsDir).task;
  const ids=[f.jobId,sibling.current_attempt_id];const sql=new Database(f.config.databasePath);
  for(const [n,id] of ids.entries())sql.prepare("UPDATE jobs SET status='completed',completed_at=?,result_json=? WHERE job_id=?").run(new Date().toISOString(),JSON.stringify({schema_version:1,job_id:id,status:"completed",summary:`成果${n}`,output:{format:"markdown",text:`詳細${n}`},artifacts:[{kind:"report",reference:`参照${n}`}],actions:[],completed_at:new Date().toISOString()}),id);
  sql.close();await f.current(f.origin);f.db.markWaiting(f.origin.event_id);
  f.db.saveCompleted(f.origin.event_id,{schema_version:1,event_id:f.origin.event_id,status:"completed",summary:"delegated",completed_at:new Date().toISOString()},path.join(f.root,"origin.json"));
  const notice=f.db.enqueueJobNotification(sibling.current_attempt_id).row;assert.equal(JSON.parse(notice.payload_json).group.transition,"all_terminal");await f.current(notice);
  for(const [n,id] of ids.entries()) {
   const response=mode==="api"?await f.client.getJob(id,notice.event_id):(await f.mcp.callTool({name:"get_job_status",arguments:{job_id:id,source_event_id:notice.event_id}})).structuredContent;
   const result=JSON.parse((response as {job:{result_json:string}}).job.result_json);assert.equal(result.summary,`成果${n}`);assert.equal(result.output.text,`詳細${n}`);assert.deepEqual(result.artifacts,[{kind:"report",reference:`参照${n}`}]);
  }
  f.setAccess(false);assert.deepEqual(await f.client.getJob(f.jobId,notice.event_id),statusNotAvailable);
  const other=await f.event(`human-completion-${mode}`);await f.current(other);assert.deepEqual(await f.client.getJob(f.jobId,other.event_id),statusNotAvailable);assert.ok(!JSON.stringify(await f.query(mode)).includes("成果0"));
 }finally{await f.close();}
});
test("完了projectionは不正・過大Resultと自由fieldを返さない",()=>{
 for(const value of ["invalid","x".repeat(1024*1024+1)])assert.equal(projectCompletionJob({job_id:"job_test",result_json:value}).result_json,null);
});
