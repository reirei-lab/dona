import assert from "node:assert/strict";
import test from "node:test";
import { buildEventPrompt } from "../src/prompt.js";
import type { EventEnvelope } from "../src/types.js";

const envelope: EventEnvelope = {
  schema_version: 1,
  source: "slack",
  external_event_id: "event-1",
  type: "message",
  occurred_at: "2026-09-24T00:00:00Z",
  subject: {},
  payload: {},
  reply_target: { workspace_id: "T1", channel_id: "C1", thread_ts: "1.0" },
};

test("通常のSlack eventとdona_jobだけにスレッド開示方針と安全な拒否時要約を渡す", () => {
  for (const source of ["slack", "dona_job"] as const) {
    const prompt = buildEventPrompt("evt-1", "/tmp/result.json", { ...envelope, source });
    assert.match(prompt, /保存済みreply_targetと同じworkspace、channel、thread/);
    assert.match(prompt, /PR\/Issue URL、CI・review結果、worker進捗/);
    assert.match(prompt, /group.transitionがprogressの中間通知ではSlackへ投稿せず/);
    assert.match(prompt, /group.attention_resolution_stateがnot_requiredまたはresolved/);
    assert.match(prompt, /automatic approvalで拒否された場合/);
    assert.match(prompt, /実質的に安全な短い要約を同じスレッドへ1回だけ投稿/);
    assert.match(prompt, /安全な要約も拒否されたら繰り返さず失敗として記録/);
    assert.match(prompt, /送信結果が曖昧な場合やtimeoutでは再送せず/);
    if (source === "dona_job") {
      assert.match(prompt, /tool引数event_idには今回の通知event_id/);
      assert.match(prompt, /source_event_idで代用しない/);
      assert.match(prompt, /通常jobにschedule専用のauthorize_job_notificationを呼ばない/);
    } else {
      assert.doesNotMatch(prompt, /tool引数event_idには今回の通知event_id/);
    }
  }
  for (const source of ["dona_schedule", "dona_update"] as const) {
    const prompt = buildEventPrompt("evt-1", "/tmp/result.json", { ...envelope, source });
    assert.doesNotMatch(prompt, /automatic approvalで拒否された場合/);
    assert.doesNotMatch(prompt, /保存済みreply_targetと同じworkspace、channel、thread/);
  }
  const scheduledResult = buildEventPrompt("evt-1", "/tmp/result.json", {
    ...envelope,
    source: "dona_job",
    payload: { owner_kind: "schedule" },
    reply_target: { kind: "owner_dm" },
  });
  assert.doesNotMatch(scheduledResult, /保存済みreply_targetと同じworkspace、channel、thread/);
  assert.doesNotMatch(scheduledResult, /automatic approvalで拒否された場合/);
  assert.match(scheduledResult, /schedule ownerの通知だけはAGENTS.mdに定めた二段階認可/);
});

test('外部承認terminalだけを保存sourceと固定宛先でmainへ渡し、不明型やdraft注入を拒否する',async()=>{
 const {envelopeFromRow}=await import('../src/prompt.js');
 const subject={workspace_id:'T_TEST',channel_id:'C_TEST',thread_ts:'1.0',actor_id:'U_TEST'},payload={request_id:'request_one',source_event_id:'evt_'+'0'.repeat(26),state:'succeeded'};
 const row={schema_version:1,source:'dona_approval',external_event_id:'external:request_one:terminal',event_type:'external_approval_finished',occurred_at:'2026-10-05T00:00:00Z',subject_json:JSON.stringify(subject),payload_json:JSON.stringify(payload),reply_target_json:JSON.stringify({kind:'slack_thread',workspace_id:subject.workspace_id,channel_id:subject.channel_id,thread_ts:subject.thread_ts}),trace_json:null};
 assert.equal(envelopeFromRow(row).source,'dona_approval');
 for(const change of [{schema_version:2},{event_type:'post_message'},{external_event_id:'external:other:terminal'},{payload_json:JSON.stringify({...payload,state:'pending'})},{payload_json:JSON.stringify({...payload,text:'draft'})},{payload_json:JSON.stringify({...payload,source_event_id:'unbound'})},{reply_target_json:JSON.stringify({kind:'slack_thread',workspace_id:'T_OTHER',channel_id:'C_TEST',thread_ts:'1.0'})},{trace_json:JSON.stringify({text:'untrusted draft'})}])assert.throws(()=>envelopeFromRow({...row,...change}));
});


test('外部承認通知は現在通知IDと保存宛先への非broadcast投稿を指示する',()=>{
 const prompt=buildEventPrompt('evt_current','/tmp/result.json',{...envelope,source:'dona_approval'});
 for(const instruction of ['保存reply_targetのworkspace/channel/thread','今回の通知event_id','payload.source_event_idで代用しない','reply_broadcast:false','mrkdwn:true','parse:none','schedule専用authorize_job_notificationは呼ばない','同じ本文を再投稿しない'])assert.ok(prompt.includes(instruction));
});
