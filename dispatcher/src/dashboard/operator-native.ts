import {rejectedCommand} from "./operator-rejection.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { DispatcherDatabase } from "../database.js";
import { stableStringify } from "../validation.js";
import { OperatorAuthError } from "./operator-auth.js";
import { operatorNativeApproval, operatorQuestions } from "./operator-commands.js";
import type { OperatorApiContext } from "./operator-api.js";
import type { ApprovalIntent } from "./operator-webauthn.js";

const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const inputSchema=z.strictObject({request_id:id,task_id:id,attempt_id:id,revision:z.number().int().positive(),
  question_id:id,kind:z.literal('approval'),accepted:z.boolean()});
interface Pending {token:string;input:z.infer<typeof inputSchema>;intent:ApprovalIntent;deadline:number}
const pending=new WeakMap<DispatcherDatabase,Map<string,Pending>>();
const hash=(value:unknown)=>createHash('sha256').update(stableStringify(value)).digest('hex');
function requests(database:DispatcherDatabase):Map<string,Pending> {
  let map=pending.get(database);if(!map){map=new Map();pending.set(database,map);}
  for(const [key,value] of map)if(value.deadline<=performance.now()||!database.operatorAuth.session(value.token))map.delete(key);
  return map;
}
async function current(database:DispatcherDatabase,context:OperatorApiContext,token:string,input:Pending['input']) {
  const state=await operatorQuestions(database,{token,task_id:input.task_id,kind:'approval'},agent=>context.readQuestions(agent));
  const question=state.questions.find(value=>value.question_id===input.question_id);
  if(!question||state.current_attempt_id!==input.attempt_id||state.revision!==input.revision)throw new OperatorAuthError('conflict');
  return hash({input,request:question.request});
}
export async function operatorNativeRequest(database:DispatcherDatabase,context:OperatorApiContext,route:string,raw:unknown) {
  const security=database.operatorWebAuthn;
  if(!security)throw new OperatorAuthError('denied');
  if(route==='options') {
    const body=z.strictObject({token:z.string().max(128),input:inputSchema}).parse(raw);
    const presentation_digest=await current(database,context,body.token,body.input);
    const intent:ApprovalIntent={request_id:body.input.request_id,decision:body.input.accepted?'approve':'reject',
      presentation_digest,expires_at:new Date(Date.now()+120000).toISOString()};
    const result=await security.approvalOptions(body.token,'approvals:native',intent);
    const map=requests(database);
    for(const [key,value] of map)if(value.token===body.token)map.delete(key);
    if(map.size>=32)throw new OperatorAuthError('limit');
    map.set(result.ceremony_id,{token:body.token,input:body.input,intent,deadline:performance.now()+120000});
    return result;
  }
  if(route!=='decide')throw new OperatorAuthError('invalid');
  const body=z.strictObject({token:z.string().max(128),ceremony_id:z.string().uuid(),response:z.record(z.string(),z.unknown())}).parse(raw);
  // Keep an expired, unconsumed ceremony long enough to report a precommit rejection.
  const map=pending.get(database),saved=map?.get(body.ceremony_id);
  if(!saved||saved.token!==body.token)throw new OperatorAuthError('denied');
  // Consume before any await: duplicate ceremony requests cannot race a commit.
  map!.delete(body.ceremony_id);
  let proof;
  try {proof=await security.verify(body.token,body.ceremony_id,body.response as unknown as AuthenticationResponseJSON);
  if(await current(database,context,body.token,saved.input)!==saved.intent.presentation_digest)throw new OperatorAuthError('conflict');
  }catch(error){return rejectedCommand(database,body.token,'native_approval',saved.input,error,true);}
  let result,commitStarted=false;
  try {result=operatorNativeApproval(database,{token:body.token,input:saved.input},(authority,_input,commit)=>{
    if(!security.verifyReceipt(proof,saved.intent,'approvals:native')||authority.device_id!==proof.device_id
      ||authority.instance_id!==proof.instance_id||authority.owner_id!==proof.owner_id||authority.grant_revision!==proof.grant_revision)throw new OperatorAuthError('denied');
    commitStarted=true;return commit();
  });}catch(error){return rejectedCommand(database,body.token,'native_approval',saved.input,error,!commitStarted);}
  context.wake();return result;
}
