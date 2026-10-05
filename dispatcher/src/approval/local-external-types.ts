import {z} from "zod";
import type {ApprovalSnapshot} from "./snapshot.js";
import type {SealedApprovalExecutionMarker} from "./execution-marker.js";
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),rev=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const externalAuthoritySchema=z.strictObject({instance_id:id,owner_id:id,device_id:id,grant_revision:rev});
export type ExternalApprovalAuthority=z.infer<typeof externalAuthoritySchema>;
export const externalIntentSchema=z.strictObject({idempotency_key:id,workspace_id:id,channel_id:id,
 thread_ts:z.string().regex(/^\d{10}\.\d{6}$/),text:z.string().min(1).max(3000)});
export type ExternalApprovalIntent=z.infer<typeof externalIntentSchema>;
export const externalStepUpSchema=externalAuthoritySchema.extend({receipt_id:id,request_id:id,decision:z.enum(["approve","reject"]),
 presentation_digest:z.string().regex(/^[a-f0-9]{64}$/),expires_at:z.iso.datetime()}).strict();
export type ExternalApprovalStepUp=z.infer<typeof externalStepUpSchema>;
export const externalSourceSchema=z.strictObject({kind:z.literal("slack"),instance_id:id,owner_id:id,requester_id:z.string().regex(/^[UW][A-Z0-9]+$/),
 source_event_id:id,source_job_id:id.nullable(),runtime_request_id:id,agent:id,generation:z.string().max(128),thread_id:z.string().max(128),turn_id:z.string().max(128),
 workspace_id:id,channel_id:id,thread_ts:z.string().regex(/^\d{10}\.\d{6}$/)});
export type ExternalApprovalSource=z.infer<typeof externalSourceSchema>;
export interface ExternalApprovalAuthPort {
 /** 登録済みruntime/source/現在Task scopeをserver-sideで再照合する。 */
 authorizeSource?(source:ExternalApprovalSource):boolean;
 /** 信頼済みMac grantの現在値を同一process内で再読。引数だけを認可証拠にしない。 */
 authorize(authority:ExternalApprovalAuthority):boolean;
 /** WebAuthn検証済みdurable receiptの全claimを照合。同じdecisionのread-only再照合を許す。 */
 verifyStepUp(receipt:ExternalApprovalStepUp):boolean;
}
export type ExternalTarget={workspace_id:string;channel_id:string;thread_ts:string};
export type SlackTargetObservation={target:ExternalTarget;observed_at:string;bot_user_id:string;bot_id:string;
 requester_id?:string;requester_authorized?:boolean;workspace_name:string;channel_name:string;revision:ApprovalSnapshot["preconditions"]["ordered_thread_revision"]};
export type ExternalSendResult={outcome:"accepted";receipt_ref:string}|{outcome:"rejected";receipt_ref:string;reason:"unauthorized"|"resource_not_visible"|"invalid_input"|"scope_denied"}|{outcome:"unknown"}|{outcome:"ambiguous"};
export interface ExternalSlackPort {
 observe(target:ExternalTarget,requesterId?:string):Promise<SlackTargetObservation>;
 send(target:ExternalTarget,text:string,marker:SealedApprovalExecutionMarker,observation:SlackTargetObservation,beforeSend:()=>void):Promise<ExternalSendResult>;
 reconcile(target:ExternalTarget,marker:SealedApprovalExecutionMarker):Promise<ExternalSendResult>;
}
