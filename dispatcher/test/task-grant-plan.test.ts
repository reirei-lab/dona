import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeTaskGrantPlan, taskGrantIntentEvidenceSchema, taskGrantIssuanceReceiptSchema, unavailableTaskGrantIssuer } from "../src/task-grant-plan.js";

const principal={kind:"human",id:"owner",workspace_id:"workspace",identity_binding_revision:1,authz_revision:1};
const start="2026-09-19T00:00:00.000Z",end="2026-09-19T01:00:00.000Z";
function plan() {return {version:"dona.task-grant-plan.v1",instance_id:"instance",tenant_id:"tenant",intent_event_id:"intent",
 requester:{...principal},task_id:"task_01m48e6bt7vk1jmapj8vzj5y12",attempt_id:"job_01m48e6bt7vk1jmapj8vzj5y12",
 policy_revision:1,idempotency_key:"slot",starts_at:start,expires_at:end,
 command:{kind:"put",expected_revision:0,grant:{grant_id:"grant",principal:{...principal},resources:[{task_id:"task_01m48e6bt7vk1jmapj8vzj5y12",
 repository_full_name:"reirei-lab/dona",repository_node_id:"repository",issue_node_id:"issue",issue_number:169,resource_revision:1,binding_revision:1}],
 epic:null,operations:["read","status"],destinations:[{workspace_id:"workspace",channel_id:"channel",thread_ts:"123.456"}],
 starts_at:start,expires_at:end,revoked_at:null,revision:1,parent:null}}};}
test("exact planのgolden・集合順序・restart・immutable snapshot",()=>{
 const input=plan(),a=encodeTaskGrantPlan(input);
 assert.equal(a.sha256,"9940a2e98cd50214d96d4e6224ff1809f005fd4b884afc3a6d502c2fb3dcd847");
 const reversed=plan();reversed.command.grant.operations.reverse();
 assert.equal(encodeTaskGrantPlan(reversed).canonical,a.canonical);
 assert.equal(encodeTaskGrantPlan(JSON.parse(a.canonical)).sha256,a.sha256);
 input.command.grant.principal.id="changed";assert.equal(a.plan.command.kind === "put" && a.plan.command.grant.principal.id,"owner");
 assert.throws(()=>{(a.plan.requester as {id:string}).id="changed";});
});
test("event・actor・Attempt・policy・operation・宛先・期限差替えは別hash",()=>{
 const original=encodeTaskGrantPlan(plan());
 const mutations=[(p:ReturnType<typeof plan>)=>{p.intent_event_id="other";},(p:ReturnType<typeof plan>)=>{p.requester.id="other";},
 (p:ReturnType<typeof plan>)=>{p.attempt_id="job_01m48e6bt7vk1jmapj8vzj5y13";},(p:ReturnType<typeof plan>)=>{p.policy_revision=2;},
 (p:ReturnType<typeof plan>)=>{p.command.grant.operations=["cancel"];},(p:ReturnType<typeof plan>)=>{p.command.grant.destinations[0]!.channel_id="public";},
 (p:ReturnType<typeof plan>)=>{p.command.grant.expires_at="2026-09-19T00:30:00.000Z";},(p:ReturnType<typeof plan>)=>{p.command.grant.epic={repository_node_id:"repository",epic_node_id:"epic",membership_revision:1,child_issue_node_ids:["issue"]} as never;}];
 for(const mutate of mutations){const p=plan();mutate(p);assert.notEqual(encodeTaskGrantPlan(p).sha256,original.sha256);}
});
test("自由文承認・未知version/field・revision・期限拡大・duplicateを拒否",()=>{
 const invalid=[{...plan(),approved:true},{...plan(),version:"v2"},"本人が承認しました",{...plan(),requester:{...principal,kind:"bot"}}];
 for(const p of invalid) assert.throws(()=>encodeTaskGrantPlan(p));
 for(const mutate of [(p:ReturnType<typeof plan>)=>{p.command.grant.revision=2;},(p:ReturnType<typeof plan>)=>{p.command.grant.expires_at="2026-09-19T02:00:00.000Z";},
 (p:ReturnType<typeof plan>)=>{p.command.grant.operations.push("read");},(p:ReturnType<typeof plan>)=>{p.expires_at=start;}]) {const p=plan();mutate(p);assert.throws(()=>encodeTaskGrantPlan(p));}
});
test("revokeにもexact revision・intent・期間を固定",()=>{
 const p={...plan(),command:{kind:"revoke",grant_id:"grant",expected_revision:1}};
 const a=encodeTaskGrantPlan(p);assert.notEqual(a.sha256,encodeTaskGrantPlan({...p,command:{...p.command,expected_revision:2}}).sha256);
 assert.throws(()=>encodeTaskGrantPlan({...p,command:{...p.command,expected_revision:0}}));
});
test("evidence/receiptは値契約だけで発行capabilityを作らない",()=>{
 const p=encodeTaskGrantPlan(plan());
 const evidence=taskGrantIntentEvidenceSchema.parse({version:1,approval_event_id:"approval",intent_event_id:"intent",plan_sha256:p.sha256,
 principal,task_id:p.plan.task_id,attempt_id:p.plan.attempt_id,policy_revision:1,identity_proof_ref:"identity",intent_proof_ref:"proof",checked_at:start,expires_at:end});
 const receipt=taskGrantIssuanceReceiptSchema.parse({version:1,receipt_id:"receipt",instance_id:"instance",tenant_id:"tenant",idempotency_key:"slot",
 plan_sha256:p.sha256,approval_event_id:evidence.approval_event_id,task_id:p.plan.task_id,attempt_id:p.plan.attempt_id,grant_id:"grant",grant_revision:1,committed_at:start});
 assert.equal(receipt.grant_revision,1);assert.equal(unavailableTaskGrantIssuer.authorize({kind:"initialize"},{} as never,{} as never),null);
 assert.equal(unavailableTaskGrantIssuer.currentBinding({} as never,{} as never,{} as never,null),false);
 assert.throws(()=>taskGrantIntentEvidenceSchema.parse({...evidence,approved:true}));
});
