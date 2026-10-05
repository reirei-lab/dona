import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OperatorAuthRegistry } from "../src/dashboard/operator-auth.js";

test("Macが選択した権限だけを一回限りのcodeで付与し、現在権限をtransaction内で確認する", () => {
  const sql = new Database(":memory:");
  try {
    const registry = new OperatorAuthRegistry(sql);
    const readCode = registry.issueCode(["tasks:read"]);
    const paired = registry.pair(readCode.code);
    assert.deepEqual(paired.session.capabilities, ["tasks:read"]);
    assert.throws(() => registry.pair(readCode.code), /denied/);
    let called = false;
    assert.throws(() => registry.withSession(paired.token, "tasks:submit", () => { called = true; }), /denied/);
    assert.equal(called, false);
    const writeCode = registry.issueCode(["tasks:read", "tasks:submit"]);
    const writer = registry.pair(writeCode.code);
    registry.withSession(writer.token, "tasks:submit", authority => {
      assert.equal(sql.inTransaction, true);
      assert.equal(authority.owner_id, paired.session.owner_id);
      assert.notEqual(authority.device_id, paired.session.device_id);
      assert.equal(authority.grant_revision, 1);
    });
    registry.revoke(writer.session.device_id);
    assert.equal(registry.session(writer.token), null);
    assert.ok(registry.session(paired.token));
    assert.throws(() => registry.withSession(writer.token, "tasks:submit", () => { called = true; }), /denied/);
    assert.equal(called, false);
    assert.equal(JSON.stringify(sql.prepare("SELECT * FROM dashboard_operator_devices").all()).includes(writer.token), false);
    registry.logout(paired.token);
    assert.equal(registry.session(paired.token), null);
  } finally { sql.close(); }
});

test("code置換・期限・総当たり制限と、restart/restore後のcookie失効を検証する", () => {
  const sql = new Database(":memory:"); let elapsed = 0;
  try {
    const registry = new OperatorAuthRegistry(sql, () => elapsed);
    const old = registry.issueCode(["tasks:read"]), current = registry.issueCode(["tasks:read"]);
    assert.throws(() => registry.pair(old.code), /denied/);
    for (let i = 0; i < 7; i++) assert.throws(() => registry.pair("wrong"), /denied/);
    assert.throws(() => registry.pair(current.code), /limit/);
    elapsed = 60_001;
    const paired = registry.pair(current.code);
    const restarted = new OperatorAuthRegistry(sql, () => elapsed);
    assert.equal(restarted.owner_id, registry.owner_id);
    assert.equal(restarted.session(paired.token), null);
    elapsed += 43_200_001;
    assert.equal(registry.session(paired.token), null);
    const expired = registry.issueCode(["tasks:read"]);
    elapsed += 300_000;
    assert.throws(() => registry.pair(expired.code), /denied/);
    assert.throws(() => registry.issueCode(["approvals:everything"]), /invalid/);
    const pending = registry.issueCode(["tasks:read"]);
    registry.revoke();
    assert.throws(() => registry.pair(pending.code), /denied/);
    assert.deepEqual(registry.status().devices, []);
  } finally { sql.close(); }
});

test("別connectionからの権限失効をcached sessionへ反映する", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-auth-"));
  const file = path.join(root, "registry.sqlite3"), sql = new Database(file), other = new Database(file);
  try {
    const registry = new OperatorAuthRegistry(sql);
    const {token, session} = registry.pair(registry.issueCode(["tasks:read", "tasks:cancel"]).code);
    other.prepare("UPDATE dashboard_operator_devices SET revision=revision+1 WHERE device_id=?").run(session.device_id);
    assert.equal(registry.session(token), null);
    assert.throws(() => registry.withSession(token, "tasks:cancel", () => assert.fail("stale grant used")), /denied/);
  } finally { other.close(); sql.close(); fs.rmSync(root, {recursive: true, force: true}); }
});
