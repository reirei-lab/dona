import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { test } from "node:test";
import { RuntimeCommandInbox } from "../src/runtime-command-inbox.js";

function request(n = 0) { return { version: "runtime-control.v1", request_id: createHash("sha256").update(String(n)).digest("hex"),
  body_sha256: "a".repeat(64), workspace: "test", workspace_id: "T1", app_id: "A1", enterprise_id: null,
  actor_id: "U1", channel_id: "C1", channel_type: "public_channel", command: { operation: "runtime.status.read.v1" } }; }
test("read-only照合とinvalid requestは空DBへschemaを書かない", t => {
  const db = new Database(":memory:"); t.after(() => db.close()); const inbox = new RuntimeCommandInbox(db);
  assert.equal(inbox.receipt(request().request_id), null);
  for (const input of [{ ...request(), approved: true }, { ...request(), command: { operation: "arbitrary.shell" } },
    { ...request(), command: { operation: "runtime.update.confirm.v1", plan_id: "plan_internal" } }]) assert.throws(() => inbox.accept(input));
  assert.equal(db.prepare("SELECT count(*) FROM sqlite_master WHERE type='table'").pluck().get(), 0);
});
test("quota到達後も既存receiptを再読し、異内容と新しい要求を拒否", t => {
  const db = new Database(":memory:"); t.after(() => db.close()); const inbox = new RuntimeCommandInbox(db);
  assert.equal(inbox.available(), true);
  const first = inbox.accept(request());
  for (let i = 1; i < 1024; i++) inbox.accept(request(i));
  assert.deepEqual(inbox.accept(request()), first);
  assert.throws(() => inbox.accept({ ...request(), actor_id: "U2" }), /runtime_command_conflict/);
  assert.throws(() => inbox.accept(request(1024)), /runtime_command_capacity/);
  assert.equal(db.prepare("SELECT count(*) FROM slack_runtime_command_inbox").pluck().get(), 1024);
  assert.equal(inbox.available(), false);
  assert.equal(db.pragma("synchronous", { simple: true }), 2);
});
test("受付のchannel種別をcanonical recordへ保存し欠落/改変を拒否", t => {
  const db = new Database(":memory:"); t.after(() => db.close()); const inbox = new RuntimeCommandInbox(db);
  for (const [n, channel_type] of ["public_channel", "private_channel", "im"].entries()) {
    const input = { ...request(n), channel_type }; inbox.accept(input);
    const stored = JSON.parse(db.prepare("SELECT request_json FROM slack_runtime_command_inbox WHERE request_id=?").pluck().get(input.request_id) as string);
    assert.equal(stored.channel_type, channel_type);
    assert.throws(() => inbox.accept({ ...input, channel_type: "mpim" }));
  }
  const { channel_type: _unused, ...raw } = request(99); assert.throws(() => inbox.accept(raw));
});
