import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {test} from "node:test";
import {AppServerMain} from "../src/app-server-main.js";
import {tempPolicy,installRelease,targetSha} from "./helpers.js";

test("App Server mainを新generationで起動し、照合済みidleだけ停止する",async()=>{
 const {root,policy}=await tempPolicy();
 policy.control_root=path.join(root,"r");
 await fs.mkdir(policy.control_root,{recursive:true,mode:0o700});await fs.mkdir(policy.config_root,{recursive:true,mode:0o700});
 for(const file of ["dispatcher.env","slack.env","mcp-dispatcher.mjs","mcp-slack.mjs"])await fs.writeFile(path.join(policy.config_root,file),"",{mode:0o600});
 const release=await fs.realpath(await installRelease(policy,targetSha));
 let agent={name:"dona-main",generation:"new",thread_id:"thread",state:"idle",startup_ready:false,cwd:release,release};
 let startupFails=false,loseStart=false;let rejectAction="",rejectCode="";let stopCount=0;const starts:Array<Record<string,unknown>>=[];
 const server=http.createServer(async(req,res)=>{
  let data="";for await(const part of req)data+=part;const p=JSON.parse(data);
  if(p.action===rejectAction){res.statusCode=409;res.end(JSON.stringify({error:rejectCode}));return;}
  if(p.action==="start"){starts.push(p.input);agent={...agent,state:"idle",startup_ready:false};if(loseStart){res.destroy();return;}}
  if(p.action==="prompt")agent={...agent,state:startupFails?"interrupted":"idle",startup_ready:!startupFails};
  if(p.action==="stop"){assert.equal(p.generation,agent.generation);stopCount++;agent={...agent,state:"stopped"};}
  res.setHeader("content-type","application/json");res.end(JSON.stringify({result:p.action==="prompt"?{turnId:"startup"}:agent}));
 });
 await new Promise<void>(resolve=>server.listen(path.join(policy.control_root,"runtime.sock"),resolve));
 try{
  const main=new AppServerMain(policy),started=await main.start("dona-main",release,"old");assert.equal(started.outcome,"started");
  const input=starts[0]!;assert.equal(input.role,"main");assert.ok((input.args as string[]).includes("check_for_update_on_startup=false"));assert.equal((input.threadConfig as {approvalsReviewer:string}).approvalsReviewer,"user");assert.equal((input.threadConfig as {model:string}).model,"gpt-6.1-sol");
  const observation=await main.status(release);
  assert.equal((await main.stop({...observation,session_id:"stale"})).outcome,"rejected");assert.equal(stopCount,0);
  assert.equal((await main.stop(observation)).outcome,"stopped");assert.equal(stopCount,1);
  const count=starts.length;
  await fs.rm(path.join(policy.config_root,"mcp-slack.mjs"));
  assert.equal((await main.start("dona-main",release,"old")).outcome,"rejected");assert.equal(starts.length,count);
  await fs.writeFile(path.join(policy.config_root,"mcp-slack.mjs"),"",{mode:0o600});
  assert.equal((await main.start("dona-main",release,"old")).outcome,"started");
  for(const code of ["runtime_agent_conflict","runtime_agent_recovery_required"]){
   rejectAction="start";rejectCode=code;const count=starts.length;
   const refused=await main.start("dona-main",release,"old");assert.equal(refused.outcome,"rejected");assert.equal(refused.error_code,code);assert.equal(starts.length,count);
  }
  rejectCode="runtime_operation_failed";assert.equal((await main.start("dona-main",release,"old")).outcome,"accepted_unknown");
  rejectAction="stop";rejectCode="runtime_stop_identity_changed";
  const refusedStop=await main.stop(await main.status(release));assert.equal(refusedStop.outcome,"rejected");assert.equal(refusedStop.error_code,rejectCode);assert.equal(stopCount,1);
  rejectCode="runtime_operation_failed";assert.equal((await main.stop(await main.status(release))).outcome,"accepted_unknown");
  rejectAction="prompt";rejectCode="runtime_not_ready";
  assert.equal((await main.start("dona-main",release,"old")).outcome,"accepted_unknown");
  rejectAction="";
  loseStart=true;const lost=await main.start("dona-main",release,"old");assert.equal(lost.outcome,"accepted_unknown");assert.equal(lost.observation.interactive_ready,false);
  assert.equal((await main.status(release)).interactive_ready,false);loseStart=false;
  startupFails=true;const failed=await main.start("dona-main",release,"old");assert.equal(failed.outcome,"accepted_unknown");
  assert.equal(failed.observation.interactive_ready,false);assert.notEqual(failed.observation.status,"idle");
  const reconciled=await main.status(release);assert.equal(reconciled.interactive_ready,false);assert.notEqual(reconciled.status,"idle");
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
});
