import assert from "node:assert/strict";
import test from "node:test";
import { ResultAccessContract, acceptedResultDigest, parseResultPRReference, type ResultAccessPorts, type ResultAccessRequest, type ResultAccessSnapshot } from "../src/result-access.js";
const canary = "PRIVATE_CANARY /secret/path https://private.invalid/download";
const attempt = "job_01m4ds4thmc0zjwan2ebnkfeat";
function fixture() {
 const request: ResultAccessRequest = { principal_id: "owner", tenant_id: "tenant", task_id: "task", attempt_id: attempt,
  terminal_revision: 2, destination: { workspace_id: "workspace", channel_id: "private", thread_ts: "1.2", visibility: "private" } };
 const pr = { repository: "reirei-lab/dona", number: 42, head_sha: "a".repeat(40), base_sha: "b".repeat(40) };
 const result = { schema_version: 1, job_id: attempt, status: "completed", summary: canary, output: { format: "text", text: canary },
  error: canary, artifacts: [{ kind: "github_pr", reference: "https://github.com/reirei-lab/dona/pull/42", head_sha: pr.head_sha, base_sha: pr.base_sha },
   { kind: "file", reference: canary }, { kind: "error", reference: canary }], completed_at: "2026-10-08T00:00:00.000Z" };
 const snapshot: ResultAccessSnapshot = { task_id: request.task_id, attempt_id: attempt, terminal_revision: 2, terminal: true,
  accepted: true, policy_revision: 1, grant_revision: 1, origin: { ...request.destination }, result_json: JSON.stringify(result), canonical_digest: acceptedResultDigest(result, attempt) };
 let operation = "read_result", allowed = true, fetches = 0;
 const ports: ResultAccessPorts = { snapshot: () => snapshot, authorize: () => allowed ? { operation, request, policy_revision: 1,
  grant_revision: 1, fields: ["status", "completed_at"], artifacts: [pr], authority: true, disclosure: true } : undefined,
  verifyPR: async () => { fetches++; return true; } };
 return { request, snapshot, result, pr, ports, contract: new ResultAccessContract(ports), operation: (v: string) => { operation = v; },
  revoke: () => { allowed = false; }, fetches: () => fetches,
  evidence: () => ({ terminal_revision: snapshot.terminal_revision, canonical_digest: snapshot.canonical_digest, prs: [pr] }) };
}
test("既定denyとread_status/read/read_resultの独立matrix、canaryのfield/artifact allowlist", async () => {
 const f = fixture();
 assert.equal((await new ResultAccessContract().read(f.request)).status, "not_available");
 for (const operation of ["read_status", "status", "read", "internal_completion"]) {
  f.operation(operation); assert.equal((await f.contract.read(f.request)).status, "not_available");
 }
 assert.equal(f.fetches(), 0); f.operation("read_result");
 const response = await f.contract.read(f.request);
 assert.deepEqual(response.result, { status: "completed", completed_at: f.result.completed_at });
 assert.equal(JSON.stringify(response).includes(canary), false);
 assert.equal(JSON.stringify(response).includes("reference"), false);
 const receipt = await f.contract.reconcile(f.request, f.evidence());
 assert.equal(receipt.outcome, "matched"); assert.equal(JSON.stringify(receipt).includes(canary), false);
 assert.equal("authorized" in receipt, false);
});
test("本人でもprivate→public、destination/principal/task swapをdeny", async () => {
 for (const patch of [{ destination: { ...fixture().request.destination, visibility: "public" } },
  { destination: { ...fixture().request.destination, channel_id: "other" } }, { principal_id: "other" }, { task_id: "other" },
  { terminal_revision: 1 }]) {
  const f = fixture(); assert.equal((await f.contract.read({ ...f.request, ...patch })).status, "not_available"); assert.equal(f.fetches(), 0);
 }
});
test("未確定/invalid/digest tamper/旧revisionはunknownで生errorを返さない", async () => {
 for (const patch of [{ accepted: false }, { terminal: false }, { result_json: canary }, { canonical_digest: "0".repeat(64) }, { terminal_revision: 1 }]) {
  const f = fixture(); Object.assign(f.snapshot, patch);
  assert.deepEqual(await f.contract.reconcile(f.request, f.evidence()), { schema_version: 1, outcome: "unknown" });
  assert.equal(JSON.stringify(await f.contract.read(f.request)).includes(canary), false);
 }
 const f = fixture(); assert.equal((await f.contract.reconcile(f.request, { ...f.evidence(), canonical_digest: "0".repeat(64) })).outcome, "unknown");
});
test("await中のlate Result/revoke/destination変更と外部取得不能をdeny", async () => {
 for (const mutate of [(f: ReturnType<typeof fixture>) => f.revoke(),
  (f: ReturnType<typeof fixture>) => { f.result.summary = "late"; f.snapshot.result_json = JSON.stringify(f.result); f.snapshot.canonical_digest = acceptedResultDigest(f.result, attempt); },
  (f: ReturnType<typeof fixture>) => { f.request.destination.channel_id = "other"; },
  (f: ReturnType<typeof fixture>) => { f.snapshot.grant_revision++; }]) {
  const f = fixture(); f.ports.verifyPR = async () => { mutate(f); return true; };
  assert.equal((await f.contract.read(f.request)).status, "not_available");
 }
 for (const verifyPR of [async () => false, async (): Promise<boolean> => { throw Error(canary); }]) {
  const f = fixture(); f.ports.verifyPR = verifyPR; assert.equal((await f.contract.reconcile(f.request, f.evidence())).outcome, "unknown");
 }
});
test("restart後もreceiptを再検証し、revokeとPR identity不一致をunknown", async () => {
 const f = fixture(), expected = f.evidence();
 assert.equal((await f.contract.reconcile(f.request, expected)).outcome, "matched");
 const restarted = new ResultAccessContract(f.ports);
 assert.equal((await restarted.reconcile(f.request, { ...expected, prs: [{ ...f.pr, head_sha: "c".repeat(40) }] })).outcome, "unknown");
 f.revoke(); assert.equal((await restarted.reconcile(f.request, expected)).outcome, "unknown");
});
test("artifact scheme/host/resource制限とSSRF fixtureはresolverへ渡さない", async () => {
 for (const reference of ["file:///secret", "http://127.0.0.1/", "https://github.com.evil/pull/42", "https://github.com@127.0.0.1/pull/42",
  "https://github.com/reirei-lab/dona/pull/42?token=secret", "https://github.com/reirei-lab/dona/pull/42#secret",
  "https://github.com/reirei-lab/dona/issues/42", "https://github.com/reirei-lab/dona/pull/042", "https://github.com/other/repo/pull/42"]) {
  const f = fixture(); f.result.artifacts = [{ kind: "github_pr", reference, head_sha: f.pr.head_sha, base_sha: f.pr.base_sha }];
  f.snapshot.result_json = JSON.stringify(f.result); f.snapshot.canonical_digest = acceptedResultDigest(f.result, attempt);
  assert.deepEqual((await f.contract.read(f.request)).artifacts, []); assert.equal(f.fetches(), 0);
 }
 assert.equal(parseResultPRReference({ kind: "github_pr", reference: "https://github.com/reirei-lab/dona/pull/42", head_sha: "a".repeat(40), base_sha: "b".repeat(40), private_url: canary }), undefined);
});
