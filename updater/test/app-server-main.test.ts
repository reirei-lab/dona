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
 let agent={name:"dona-main",generation:"new",thread_id:"thread",state:"idle",cwd:release,release};
 let stopCount=0;const starts:Array<Record<string,unknown>>=[];
 const server=http.createServer(async(req,res)=>{
  let data="";for await(const part of req)data+=part;const p=JSON.parse(data);
  if(p.action==="start"){starts.push(p.input);agent={...agent,state:"idle"};}
  if(p.action==="stop"){assert.equal(p.generation,agent.generation);stopCount++;agent={...agent,state:"stopped"};}
  res.setHeader("content-type","application/json");res.end(JSON.stringify({result:p.action==="prompt"?{turnId:"startup"}:agent}));
 });
 await new Promise<void>(resolve=>server.listen(path.join(policy.control_root,"runtime.sock"),resolve));
 try{
  const main=new AppServerMain(policy),started=await main.start("dona-main",release,"old");assert.equal(started.outcome,"started");
  const input=starts[0]!;assert.equal(input.role,"main");assert.equal((input.threadConfig as {model:string}).model,"gpt-6.1-sol");
  const observation=await main.status(release);
  assert.equal((await main.stop({...observation,session_id:"stale"})).outcome,"rejected");assert.equal(stopCount,0);
  assert.equal((await main.stop(observation)).outcome,"stopped");assert.equal(stopCount,1);
  agent={...agent,state:"interrupted"};assert.equal((await main.start("dona-main",release,"new")).outcome,"accepted_unknown");
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});}
});
