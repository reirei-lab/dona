import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const sha = "2".repeat(40);
const scripts = new URL("../../scripts/", import.meta.url);
const { writeControlReceipt } = await import(new URL("write-control-receipt.mjs", scripts).href);
const { createAttempt, advanceAttempt } = await import(new URL("control-attempt-ledger.mjs", scripts).href);

// This child is a health fixture, not a launchd service or Dona worker. Registration
// is injected below; the socket, lock, PID and ps start observation are real/private.
async function startFixture(root: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import http from 'node:http'; import { execFileSync } from 'node:child_process';
    const start = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {encoding:'utf8'}).trim();
    fs.writeFileSync(${JSON.stringify(path.join(root, "updater.start.lock"))}, JSON.stringify({pid:process.pid,process_start:start}), {mode:0o600});
    const server = http.createServer((req,res) => { res.setHeader('content-type','application/json');
      res.end(JSON.stringify({status:'ready',service:'updater',build_sha:${JSON.stringify(sha)},pid:process.pid,process_start:start,update_schema:3})); });
    server.listen(${JSON.stringify(path.join(root, "updater.sock"))}, () => process.send({ready:true}));
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("health fixture startup timeout")), 5_000);
    child.once("message", () => { clearTimeout(timer); resolve(); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("health fixture exited before readiness")); });
  }).catch(async error => { await stopFixture(child); throw error; });
  return child;
}
async function stopFixture(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
}
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dcr-")));
  const tree = path.join(root, "updater");
  const release = path.join(root, "release");
  const attempt = path.join(root, `${sha}.TEST`);
  const output = path.join(root, "receipt.json");
  await fs.chmod(root, 0o700);
  for (const dir of [tree, release, attempt, path.join(attempt, "updater.previous")]) await fs.mkdir(dir, { mode: 0o700 });
  await fs.chmod(release, 0o500);
  const artifact = path.join(root, "artifact");
  const backup = path.join(root, "backup");
  const rehearsal = path.join(root, "rehearsal");
  await fs.writeFile(artifact, "private", { mode: 0o600 });
  await fs.writeFile(backup, "backup fixture", { mode: 0o600 });
  await fs.writeFile(rehearsal, JSON.stringify({ schema_version: 1,
    backup_sha256: createHash("sha256").update(await fs.readFile(backup)).digest("hex"),
    old_schema: 3, new_schema: 3, rollback: "same_schema", old_binary_restored_backup_readable: true,
    old_database_module_sha256: "a".repeat(64), new_database_module_sha256: "b".repeat(64) }), { mode: 0o600 });
  createAttempt(attempt, "1".repeat(40), sha, artifact, artifact, artifact, artifact,
    "f".repeat(64), tree, release, artifact, artifact, "-");
  for (const phase of ["updater_stop_intent", "updater_stopped", "backup_verified", "dispatcher_stop_intent",
    "dispatcher_stopped", "dispatcher_start_intent", "dispatcher_started", "control_swapped",
    "updater_start_intent", "updater_started", "verified"]) {
    advanceAttempt(attempt, phase, "none", ...(phase === "backup_verified" ? [backup, rehearsal] : []));
  }
  let child = await startFixture(root);
  return { root, output, attempt, child: () => child,
    write: (options: object = {}) => writeControlReceipt(attempt, output, sha, tree, path.join(root, "updater.sock"), "gui/501", {
      registrationRead: async () => `pid = ${child.pid}\nDONA_UPDATER_BUILD_SHA => ${sha}`,
      ...options,
    }),
    replace: async () => { await stopFixture(child); await fs.unlink(path.join(root, "updater.sock")); child = await startFixture(root); },
    cleanup: async () => { await stopFixture(child); await fs.chmod(release, 0o700); await fs.rm(root, { recursive: true, force: true }); },
  };
}

test("隔離childのfresh health・lock・PID・開始identityをcontrol receiptへ束縛する", async () => {
  const f = await fixture();
  try {
    await f.write();
    const receipt = JSON.parse(await fs.readFile(f.output, "utf8"));
    assert.equal(receipt.process_identity.pid, f.child().pid);
    assert.equal(receipt.process_identity.build_sha, sha);
    assert.equal(receipt.process_identity.update_schema, 3);
    assert.equal(receipt.process_identity.process_start,
      execFileSync("/bin/ps", ["-p", String(f.child().pid), "-o", "lstart="], { encoding: "utf8" }).trim());
    await assert.rejects(f.write(), { code: "EEXIST" });
  } finally { await f.cleanup(); }
});

test("同SHAのsocket processが確認途中に交代するとreceiptを公開しない", async () => {
  const f = await fixture();
  let observations = 0;
  try {
    await assert.rejects(f.write({ processStartRead: async (pid: number) => {
      const start = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
      if (++observations === 1) await f.replace();
      return start;
    } }), /process identity changed/);
    await assert.rejects(fs.stat(f.output), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

test("fresh health確認中のledger変更と別登録PIDではreceiptを公開しない", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.write({ registrationRead: async () => `pid = 1\nDONA_UPDATER_BUILD_SHA => ${sha}` }), /disagree/);
    await assert.rejects(fs.stat(f.output), { code: "ENOENT" });
    await assert.rejects(f.write({ processStartRead: async (pid: number) => {
      const file = path.join(f.attempt, "attempt.json");
      const current = JSON.parse(await fs.readFile(file, "utf8"));
      await fs.writeFile(file, JSON.stringify({ ...current, sequence: current.sequence + 1 }));
      return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    } }), /artifacts changed/);
    await assert.rejects(fs.stat(f.output), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});


test("旧health形式と別schemaはfresh receiptの根拠として採用しない", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.write({ healthRead: async () => ({ status: "ready", service: "updater", build_sha: sha, update_schema: 3 }) }), /process identity is invalid/);
    await assert.rejects(f.write({ healthRead: async () => ({ status: "ready", service: "updater", build_sha: sha, update_schema: 4, pid: f.child().pid, process_start: "start" }) }), /not observed before timeout/);
    await assert.rejects(fs.stat(f.output), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});
