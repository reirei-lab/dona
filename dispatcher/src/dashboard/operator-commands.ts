import {z} from "zod";
import type {DispatcherDatabase} from "../database.js";
import type {LocalDashboardAuthority,LocalDashboardQuestionReply,LocalDashboardReceipt} from "../local-dashboard-commands.js";
import type {TaskRow} from "../task-execution.js";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision=z.number().int().positive();
const request=id;
const create=z.strictObject({request_id:request,objective:z.string().trim().min(1).max(100000),workspace:z.discriminatedUnion("kind",[
  z.strictObject({kind:z.literal("scratch")}),z.strictObject({kind:z.literal("github"),repository:z.string().regex(/^[\w.-]+\/[\w.-]+$/),base_ref:z.string().min(1).max(255).optional()})])});
const cancel=z.strictObject({request_id:request,task_id:id,attempt_id:id,revision});
const question=cancel.extend({question_id:id,kind:z.literal("question"),answers:z.record(z.string().min(1).max(128),z.strictObject({answers:z.array(z.string().max(10000)).min(1).max(32)}))});
const approval=cancel.extend({question_id:id,kind:z.literal("approval"),accepted:z.boolean()});
const operations=["create","cancel","question_reply","native_approval"] as const;
type Operation=typeof operations[number];
type Capability="tasks:submit"|"tasks:cancel"|"approvals:native";
const capability=(operation:Operation):Capability=>operation==="cancel"?"tasks:cancel":operation==="native_approval"?"approvals:native":"tasks:submit";
export type OperatorCommandDatabase=Pick<DispatcherDatabase,"createLocalDashboardTask"|"cancelLocalDashboardTask"|"enqueueLocalDashboardQuestionReply"|"getLocalDashboardReceipt"|"getLocalDashboardTask"> & {
  operatorAuth:{withSession<T>(token:string,capability:Capability,execute:(authority:LocalDashboardAuthority)=>T):T};
};
export interface OperatorCommandPaths {jobsWorkspaceRoot:string;jobResultsDir:string}
export function publicCommandReceipt(receipt:LocalDashboardReceipt) {
  return {request_id:receipt.request_id,operation:receipt.operation,task_id:receipt.task_id,attempt_id:receipt.attempt_id,
    task_revision:receipt.task_revision,event_id:receipt.event_id,created_at:receipt.created_at};
}
function publicTask(task:TaskRow){return {task_id:task.task_id,current_attempt_id:task.current_attempt_id,revision:task.revision,
  state:task.state,desired_state:task.desired_state,wait_reason:task.wait_reason};}
function project(result:ReturnType<DispatcherDatabase["createLocalDashboardTask"]>){return {outcome:result.outcome,receipt:publicCommandReceipt(result.receipt),task:publicTask(result.task)};}
/** private UDS専用。session照合とTask/receiptのwriteを同じDB transactionに閉じる。 */
export function operatorCommand(database:OperatorCommandDatabase,paths:OperatorCommandPaths,raw:unknown) {
  const body=z.strictObject({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),operation:z.enum(["create","cancel","question_reply","receipt"]),input:z.unknown()}).parse(raw);
  if(body.operation==="receipt") {
    const input=z.strictObject({request_id:request,operation:z.enum(operations)}).parse(body.input);
    return database.operatorAuth.withSession(body.token,capability(input.operation),authority=>{
      const receipt=database.getLocalDashboardReceipt(authority,input.request_id);
      if(receipt&&receipt.operation!==input.operation)throw Error("operator_command_denied");
      return {receipt:receipt?publicCommandReceipt(receipt):null};
    });
  }
  if(body.operation==="create") {
    const parsed=create.parse(body.input);
    const input={...parsed,workspace:parsed.workspace.kind==="scratch"?parsed.workspace:{kind:"github" as const,repository:parsed.workspace.repository,...(parsed.workspace.base_ref?{base_ref:parsed.workspace.base_ref}:{})}};
    return database.operatorAuth.withSession(body.token,"tasks:submit",authority=>project(database.createLocalDashboardTask(authority,input,paths.jobsWorkspaceRoot,paths.jobResultsDir)));
  }
  if(body.operation==="cancel") {
    const input=cancel.parse(body.input);
    return database.operatorAuth.withSession(body.token,"tasks:cancel",authority=>project(database.cancelLocalDashboardTask(authority,input)));
  }
  const input=question.parse(body.input);
  return database.operatorAuth.withSession(body.token,"tasks:submit",authority=>project(database.enqueueLocalDashboardQuestionReply(authority,input)));
}
/** WebAuthnの検証済みexact intentを消費するcallbackが必要。tokenだけの入口は持たない。 */
export function operatorNativeApproval(database:OperatorCommandDatabase,raw:unknown,
  verified:(authority:LocalDashboardAuthority,input:Extract<LocalDashboardQuestionReply,{kind:"approval"}>,commit:()=>ReturnType<typeof project>)=>ReturnType<typeof project>) {
  const body=z.strictObject({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),input:approval}).parse(raw);
  return database.operatorAuth.withSession(body.token,"approvals:native",authority=>verified(authority,Object.freeze(body.input),()=>project(database.enqueueLocalDashboardQuestionReply(authority,body.input))));
}


/** runtime I/Oの前後でowner・revision・Attemptとsession権限を照合する。 */
export async function operatorQuestions(database:OperatorCommandDatabase,raw:unknown,
  readQuestions:(agent:string)=>Promise<import("../app-server/store.js").QuestionRecord[]>) {
  const body=z.strictObject({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),task_id:id,kind:z.enum(["question","approval"])}).parse(raw);
  const cap=body.kind==="approval"?"approvals:native":"tasks:submit";
  const before=database.operatorAuth.withSession(body.token,cap,authority=>database.getLocalDashboardTask(authority,body.task_id));
  const questions=before.session_identity?await readQuestions(before.row.agent_name):[];
  return database.operatorAuth.withSession(body.token,cap,authority=>{
    const current=database.getLocalDashboardTask(authority,body.task_id);
    if(current.task.revision!==before.task.revision||current.task.current_attempt_id!==before.task.current_attempt_id||current.session_identity!==before.session_identity)throw Error("task_revision_conflict");
    return {task_id:current.task.task_id,current_attempt_id:current.task.current_attempt_id,revision:current.task.revision,
      questions:questions.filter(q=>q.kind===body.kind&&q.state==="pending"&&q.agent===current.row.agent_name&&JSON.stringify([q.generation,q.thread_id])===current.session_identity)
        .map(q=>({question_id:q.question_id,kind:q.kind,state:q.state,request:JSON.parse(q.payload_json)}))};
  });
}
