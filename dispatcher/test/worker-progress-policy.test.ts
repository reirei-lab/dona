import assert from "node:assert/strict";
import {test} from "node:test";
import {evaluateProgress,progressActions,type ProgressContext} from "../src/worker-progress-policy.js";
const now="2026-10-12T08:00:00.000Z";
const report={message_id:"message-one",payload:{kind:"checkpoint" as const,summary:"検証が進みました"},occurred_at:now};
function context(patch:Partial<ProgressContext>={}):ProgressContext{return {event_id:"event-one",job_id:"job-one",report_current:true,current:true,desired_state:"running",phase:"running",now,report,
 members:[{job_id:"job-one",phase:"running",report}],group_attention:false,group_terminal:false,context_complete:true,silence_threshold_ms:900000,minimum_report_interval_ms:60000,...patch};}
const first=evaluateProgress(context());
const previous={fingerprint:first.fingerprint!,action:first.action,decided_at:"2026-10-12T07:55:00.000Z"};
const cases:Array<[string,Partial<ProgressContext>,string,string?]>=[
 ["初回checkpoint",{},"report_to_user"],
 ["後続報告で置き換わったevent",{report_current:false},"ack_internal","stale_report"],
 ["同じ内容の別sequence",{report:{...report,message_id:"message-two"},previous},"ack_internal","duplicate_report"],
 ["NFKCと空白の違い",{report:{...report,payload:{kind:"checkpoint",summary:" 検証が進みました  "}},previous},"ack_internal"],
 ["低価値の短周期報告",{last_user_report_at:"2026-10-12T07:59:50.000Z"},"aggregate_wait","report_cadence"],
 ["risk上昇はcadenceより優先",{report:{...report,payload:{kind:"risk",summary:"確認が必要です",severity:"high"}},previous:{...previous,severity:"low"},last_user_report_at:now},"report_to_user","risk_escalation"],
 ["ETA変化はcadenceより優先",{report:{...report,payload:{kind:"checkpoint",summary:"見込み 40 分"}},previous:{...previous,eta_minutes:10},last_user_report_at:now},"report_to_user","eta_drift"],
 ["question",{report:{...report,payload:{kind:"question",question:"どちらを選びますか？"}}},"ask_user"],
 ["decision_request",{report:{...report,payload:{kind:"decision_request",question:"方式を選んでください",options:["方式A","方式B"]}}},"ask_user"],
 ["同じ質問を二度尋ねない",{report:{...report,payload:{kind:"question",question:"どちら？"}},previous:{...previous,action:"ask_user",message_id:report.message_id}},"ack_internal","question_already_recorded"],
 ["無音",{report:undefined,silence_since:"2026-10-12T07:40:00.000Z"},"ask_worker"],
 ["無音への追加質問の重複",{report:undefined,silence_since:"2026-10-12T07:40:00.000Z",previous:{...previous,action:"ask_worker",decided_at:"2026-10-12T07:59:00.000Z"}},"ack_internal"],
 ["指示の受理不明はreceiptだけ照合",{pending_instruction:{message_id:"instruction",state:"unknown"}},"instruct_worker"],
 ["受理済み未配送指示",{pending_instruction:{message_id:"instruction",state:"pending"}},"instruct_worker"],
 ["siblingを集約してから報告",{members:[{job_id:"job-one",phase:"running",report},{job_id:"job-two",phase:"running"}]},"aggregate_wait"],
 ["1件完了を全件完了にしない",{members:[{job_id:"job-one",phase:"running",report},{job_id:"job-two",phase:"completed"}]},"report_to_user"],
 ["group attention優先",{group_attention:true},"ack_internal","terminal_notification_priority"],
 ["all terminal優先",{group_terminal:true},"ack_internal","terminal_notification_priority"],
 ["旧Attempt",{current:false},"ack_internal","attempt_unavailable"],
 ["取消中",{phase:"cancelling",members:[{job_id:"job-one",phase:"cancelling"}]},"ack_internal"],
 ["pause",{desired_state:"paused"},"ack_internal"],
 ["不完全なsnapshot",{context_complete:false},"ack_internal","context_incomplete"],
 ["重複group member",{members:[{job_id:"job-one",phase:"running"},{job_id:"job-one",phase:"running"}]},"ack_internal","context_incomplete"],
];
for(const [name,patch,action,reason] of cases)test(name,()=>{const result=evaluateProgress(context(patch));assert.equal(result.action,action);if(reason)assert.equal(result.reason,reason);assert.ok(progressActions.includes(result.action));});
for(const canary of ["sk-proj-canary0123456789abcdef","https://private.invalid/data","/Users/private/log","stdout private-data","curl private-data"])test(`危険なprojectionを返さない: ${canary.split(" ")[0]}`,()=>{
 const result=evaluateProgress(context({report:{...report,payload:{kind:"checkpoint",summary:canary}}}));assert.equal(result.action,"ack_internal");assert.equal(result.safe_projection,undefined);assert.equal(result.target,null);assert.ok(!JSON.stringify(result).includes(canary));
});
test("group siblingのcanaryもLLM入力候補から拒否する",()=>{const result=evaluateProgress(context({members:[{job_id:"job-one",phase:"running",report},{job_id:"job-two",phase:"running",report:{...report,payload:{kind:"risk",severity:"high",summary:"sk-proj-canary0123456789abcdef"}}}]}));assert.equal(result.reason,"unsafe_projection");assert.equal(result.safe_projection,undefined);});
test("schema不一致・group上限・モデル入力不明はfail closed",()=>{for(const raw of [null,{...context(),extra:"forged"},{...context(),members:Array(33).fill(context().members[0])}]){const result=evaluateProgress(raw);assert.equal(result.reason,"policy_input_invalid");assert.equal(result.target,null);}});


test("同じgroupの準備済み報告を再び投稿候補にしない",()=>{const first=evaluateProgress(context());const next=evaluateProgress(context({last_presentation_fingerprint:first.observed!.group_fingerprint,last_presentation_at:now}));assert.equal(next.action,"ack_internal");assert.equal(next.reason,"group_progress_already_reserved");});
test("短周期の新しい意味はdurableな集約待ちへ送る",()=>{const next=evaluateProgress(context({report:{...report,payload:{kind:"checkpoint",summary:"別の検証も完了しました"}},last_presentation_at:now}));assert.equal(next.action,"aggregate_wait");assert.equal(next.reason,"report_cadence");});
test("見込み時間の全角数字も同じdeterministic評価へ正規化する",()=>{const next=evaluateProgress(context({report:{...report,payload:{kind:"checkpoint",summary:"残り４０分"}},previous:{...previous,eta_minutes:10}}));assert.equal(next.signals.eta_changed,true);assert.equal(next.observed?.eta_minutes,40);});


test("1 workerだけのhigh riskを集約待ちやcadenceで隠さない",()=>{const next=evaluateProgress(context({last_presentation_at:now,members:[{job_id:"job-one",phase:"running",report},{job_id:"job-two",phase:"running",report:{...report,payload:{kind:"risk",severity:"high",summary:"並行作業で確認が必要です"}}}]}));assert.equal(next.action,"report_to_user");assert.equal(next.signals.risk_escalation,true);assert.equal(next.safe_projection?.members?.length,2);});

for(const summary of ["作業を継続しています。","調査を続けています","確認中です。"])
 test(`具体的な変化のないheartbeatを内部受領する: ${summary}`,()=>{
  const d=evaluateProgress(context({report:{...report,payload:{kind:"checkpoint",summary}}}));
  assert.equal(d.action,"ack_internal");assert.equal(d.reason,"heartbeat_without_change");assert.equal(d.signals.novelty,false);
 });
for(const state of ["pending","unknown"] as const){
 test(`指示${state}中も新しい質問を隠さない`,()=>{
  const d=evaluateProgress(context({report:{...report,payload:{kind:"question",question:"利用者の選択は？"}},pending_instruction:{message_id:"instruction",state}}));
  assert.equal(d.action,"ask_user");assert.equal(d.safe_projection?.question,"利用者の選択は？");
 });
 test(`指示${state}中もhigh riskを隠さない`,()=>{
  const d=evaluateProgress(context({report:{...report,payload:{kind:"risk",severity:"high",summary:"確認が必要です"}},pending_instruction:{message_id:"instruction",state}}));
  assert.equal(d.action,"report_to_user");assert.equal(d.signals.risk_escalation,true);
 });
}
