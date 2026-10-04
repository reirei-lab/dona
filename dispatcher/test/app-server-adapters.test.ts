import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {test} from "node:test";
import {AppServerJobRuntime} from "../src/app-server/adapters.js";
import type {AgentRecord} from "../src/app-server/store.js";
import type {JobRow} from "../src/types.js";
import {DispatcherDatabase} from "../src/database.js";
import {JobSupervisor} from "../src/job-supervisor.js";
import {tempConfig,eventEnvelope} from "./helpers.js";

test("取消のtransport例外を分類しcancellingに取り残さない",async()=>{
 const {root,config}=await tempConfig(),db=new DispatcherDatabase(config.databasePath),runtime=new AppServerJobRuntime(config);
 const supervisor=new JobSupervisor(db,runtime,config,{debug(){},info(){},warn(){},error(){}},()=>{});
 try{
  for(const afterSend of [false,true]) {
   const event=db.enqueue(eventEnvelope(`cancel-${afterSend}`)).row;
   const job=db.createJob({source_event_id:event.event_id,objective:"test",workspace:{kind:"scratch"}},config.jobsWorkspaceRoot,config.jobResultsDir).row;
   db.beginJobPreparation(job.job_id);db.setJobRuntime(job.job_id,"worker","worker");db.beginJobDispatch(job.job_id);db.markJobRunning(job.job_id);
   let sends=0;
   runtime.client.status=async()=>{if(!afterSend)throw Error("socket unavailable");return {generation:"g"} as AgentRecord;};
   runtime.client.stop=async()=>{sends++;throw Error("response lost");};
   await assert.rejects(supervisor.cancel(job.job_id,event.event_id,"test cancel"),/cancellation requires review/);
   assert.equal(db.getJob(job.job_id)?.status,"needs_review");assert.equal(db.getJob(job.job_id)?.last_error_code,afterSend?"cancel_acceptance_unknown":"cancel_not_sent");assert.equal(sends,afterSend?1:0);
  }
 }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

test("scratch continuationの作業ディレクトリ消失・symlinkを拒否する",async()=>{
 const {root,config}=await tempConfig(),runtime=new AppServerJobRuntime(config),origin="job_"+"0".repeat(26),workspace=path.join(config.jobsWorkspaceRoot,"scratch",origin);
 const row={job_id:"job_"+"1".repeat(26),workspace_path:workspace,workspace_json:JSON.stringify({kind:"scratch",_dona_handoff:{workspace_job_id:origin}})} as JobRow;
 try{
  await assert.rejects(runtime.prepare(row));await assert.rejects(fs.stat(workspace),{code:"ENOENT"});
  await fs.mkdir(path.dirname(workspace),{recursive:true});await fs.symlink(root,workspace);await assert.rejects(runtime.prepare(row),/continuation_workspace_missing/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
