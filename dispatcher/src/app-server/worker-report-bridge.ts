import {WorkerMessageError} from "../worker-messaging.js";
import type {DispatcherDatabase} from "../database.js";
import {RuntimeClient} from "./client.js";
import {stableStringify} from "../validation.js";

/** host queue→既存ledger。workerのidentity/宛先申告を受けず現在Attemptを再照合する。 */
export class AppServerWorkerReportBridge {
 private timer:NodeJS.Timeout|undefined;private operation:Promise<void>|undefined;private stopping=false;
 constructor(private readonly database:DispatcherDatabase,private readonly runtime:RuntimeClient,private readonly onError:(error:unknown)=>void=()=>{}){}
 async runOnce():Promise<number>{
  await this.runtime.workerReportAvailability(true);let accepted=0;
  for(const request of await this.runtime.workerReports()) {
   try {
   const job=this.database.getJob(request.attempt_id),task=this.database.tasks.forAttempt(request.attempt_id);
   if(!job||!task||task.current_attempt_id!==job.job_id||task.desired_state!=="running"||job.agent_name!==request.agent||!["running","blocked"].includes(job.status))continue;
   const agent=await this.runtime.status(request.agent);
   if(!agent||agent.role!=="worker"||agent.generation!==request.generation||agent.thread_id!==request.thread_id||(agent.turn_id!==null&&agent.turn_id!==request.turn_id)||!["working","waiting"].includes(agent.state))continue;
   const identity=JSON.stringify([request.generation,request.thread_id]);
   if(this.database.getJobLiveSessionIdentity(job.job_id)?.herdr_agent_session_id!==identity)continue;
   const input=JSON.parse(request.payload_json) as {payload:unknown;correlation_message_id?:string;conversation_revision?:number};
   const canonical=stableStringify(input);
   if([job.objective,job.workspace_path,job.result_path].some(value=>value&&canonical.includes(value))){await this.runtime.resolveWorkerReport(request.agent,request.request_id,{state:"denied",diagnostic:"payload_rejected"});continue;}
   const report={schema_version:1,source_event_id:job.source_event_id,
     producer_sequence:request.request_sequence,idempotency_key:request.report_key,occurred_at:request.created_at,payload:input.payload,
     ...(input.correlation_message_id?{correlation_message_id:input.correlation_message_id}:{}),...(input.conversation_revision!==undefined?{conversation_revision:input.conversation_revision}:{})};
   let result;
   try{result=this.database.acceptTaskWorkerReport(job.job_id,identity,report);}
   catch(error){
    if(!(error instanceof WorkerMessageError))throw error;
    const diagnostic=error.code==="worker_report_payload_denied"?"payload_rejected":error.code==="worker_report_attempt_not_current"?"attempt_unavailable":"report_rejected";
    await this.runtime.resolveWorkerReport(request.agent,request.request_id,{state:"denied",diagnostic});continue;
   }
   await this.runtime.resolveWorkerReport(request.agent,request.request_id,{message_id:result.message.message_id,receipt_id:result.receipt_id,outcome:result.outcome});accepted++;
   }catch(error){this.onError(error);}
  }
  return accepted;
 }
 start(){this.stopping=false;this.run();this.timer=setInterval(()=>this.run(),1000);this.timer.unref();}
 private run(){if(this.operation||this.stopping)return;this.operation=this.runOnce().then(()=>{},this.onError).finally(()=>{this.operation=undefined;});}
 async stop(){this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.operation;await this.runtime.workerReportAvailability(false).catch(this.onError);}
}

/** ledgerの指示だけを元owner/current Attempt/current runtimeへ配送する。 */
export class AppServerWorkerInstructionController {
 constructor(private readonly database:DispatcherDatabase,private readonly runtime:RuntimeClient){}
 async steer(jobId:string,sourceEventId:string,text:string,messageId?:string):Promise<unknown>{
  if(!messageId)throw Error("worker_instruction_identity_required");
  const task=this.database.tasks.forAttempt(jobId),job=this.database.getJob(jobId);
  if(!job||!task||task.current_attempt_id!==jobId||task.desired_state!=="running"||!["running","blocked"].includes(job.status))throw Error("worker_instruction_attempt_not_current");
  this.database.tasks.assertOwner(task.task_id,sourceEventId,true);
  if(this.database.workerMessages.instructionForDelivery(jobId,sourceEventId,messageId)!==text)throw Error("worker_instruction_content_conflict");
  const identity=this.database.getJobLiveSessionIdentity(jobId)?.herdr_agent_session_id;
  if(!identity)throw Error("worker_instruction_runtime_unbound");
  const [generation,thread_id]=JSON.parse(identity) as unknown[];
  if(typeof generation!=="string"||typeof thread_id!=="string")throw Error("worker_instruction_runtime_unbound");
  const scope={attempt_id:jobId,generation,thread_id};
  const receipt=await this.runtime.workerInstructionReceipt(job.agent_name,messageId,text,scope);
  if(receipt.state==="accepted")return receipt;
  if(receipt.state!=="not_found")throw Error("worker_instruction_acceptance_unknown");
  const current=this.database.tasks.forAttempt(jobId),currentJob=this.database.getJob(jobId);
  if(!current||current.current_attempt_id!==jobId||current.desired_state!=="running"||!currentJob||!["running","blocked"].includes(currentJob.status)||this.database.getJobLiveSessionIdentity(jobId)?.herdr_agent_session_id!==identity)throw Error("worker_instruction_attempt_not_current");
  return this.runtime.workerInstruction(job.agent_name,messageId,text,scope);
 }
}
