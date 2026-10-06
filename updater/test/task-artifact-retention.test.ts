import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Task artifact retention uses private DB and descriptor-relative fault fixtures", () => {
  const result = spawnSync("python3", ["-B", "test_task_artifact_retention.py", "-v"], {
    cwd: fileURLToPath(new URL("../../scripts/maintenance", import.meta.url)),
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
