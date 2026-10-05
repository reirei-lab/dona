import {ExternalApprovalPrecommitError} from '../approval/local-external-service.js';
import {commandRejection} from './operator-rejection.js';
import { z } from 'zod';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { DispatcherDatabase } from '../database.js';
import type { OperatorApiContext } from './operator-api.js';
import { OperatorAuthError } from './operator-auth.js';
import type { ApprovalIntent } from './operator-webauthn.js';
const token=z.string().regex(/^[A-Za-z0-9_-]{43}$/),id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
interface Pending {token:string;intent:ApprovalIntent;deadline:number}
const pending=new WeakMap<DispatcherDatabase,Map<string,Pending>>();
function requests(database:DispatcherDatabase) {
  let map=pending.get(database);if(!map){map=new Map();pending.set(database,map);}
  for(const [key,value] of map)if(value.deadline<=performance.now()||!database.operatorAuth.session(value.token))map.delete(key);
  return map;
}
export async function operatorExternalRequest(database:DispatcherDatabase,context:OperatorApiContext,route:string,raw:unknown) {
  const body=z.record(z.string(),z.unknown()).parse(raw),sessionToken=token.parse(body.token);
  const authority=()=>database.operatorAuth.withSession(sessionToken,'approvals:external',value=>value);
  const actor=authority();
  const service=context.external;
  if(route==='list') {
    const input=z.strictObject({token,after:z.string().max(2048).optional()}).parse(raw);
    if(!service)return {available:false,reason:'setup_required'};
    const result=service.list(actor,input.after??null);authority();return {available:true,...result};
  }
  if(!service)throw new OperatorAuthError('denied');
  if(route==='status') {
    const input=z.strictObject({token,request_id:id}).parse(raw);
    const result=service.status(actor,input.request_id);authority();return result;
  }
  if(route==='present') {
    const input=z.strictObject({token,request_id:id}).parse(raw);
    const result=await service.present(actor,input.request_id);authority();return result;
  }
  const security=database.operatorWebAuthn;
  if(!security)throw new OperatorAuthError('denied');
  if(route==='options') {
    const input=z.strictObject({token,request_id:id,decision:z.enum(['approve','reject']),presentation_digest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(raw);
    const presentation=await service.present(actor,input.request_id);
    if(presentation.presentation_digest!==input.presentation_digest)throw new OperatorAuthError('conflict');
    const intent:ApprovalIntent={request_id:input.request_id,decision:input.decision,presentation_digest:input.presentation_digest,expires_at:presentation.expires_at};
    const result=await security.approvalOptions(sessionToken,'approvals:external',intent);
    const map=requests(database);for(const [key,value] of map)if(value.token===sessionToken)map.delete(key);
    if(map.size>=32)throw new OperatorAuthError('limit');
    map.set(result.ceremony_id,{token:sessionToken,intent,deadline:performance.now()+120000});return result;
  }
  if(route!=='decide')throw new OperatorAuthError('invalid');
  const input=z.strictObject({token,ceremony_id:z.string().uuid(),response:z.record(z.string(),z.unknown())}).parse(raw);
  // Keep an expired, unconsumed ceremony long enough to report a precommit rejection.
  const map=pending.get(database),saved=map?.get(input.ceremony_id);
  if(!saved||saved.token!==sessionToken)throw new OperatorAuthError('denied');
  map!.delete(input.ceremony_id);
  const rejectBeforeDecision=()=>{
    // A new validation failure must not hide a previously committed decision.
    if(service.status(authority(),saved.intent.request_id).decision)throw Error('external_approval_reconciliation_required');
    return commandRejection(saved.intent.request_id,'external_approval');
  };
  let proof;
  try {proof=await security.verify(sessionToken,input.ceremony_id,input.response as unknown as AuthenticationResponseJSON);
  if(!security.verifyReceipt(proof,saved.intent,'approvals:external'))throw new OperatorAuthError('denied');
  }catch {return rejectBeforeDecision();}
  let result;
  try {result=await service.decide(authority(),proof);}
  catch(error){if(error instanceof ExternalApprovalPrecommitError)return rejectBeforeDecision();throw error;}
  authority();
  return result.status==='denied'?rejectBeforeDecision():result;
}
