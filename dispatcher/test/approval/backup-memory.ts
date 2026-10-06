import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { operationsPolicyFixture } from "./fixtures/operations.js";
import { notification, scope } from "./fixtures/broker.js";
import { executionKey } from "./fixtures/execution.js";
import { ApprovalOperations } from "../../src/approval/operations.js";
import { ApprovalBackupRestore } from "../../src/approval/backup-restore.js";

test("metadata backupのmemoryはsource DBの大きなfree-page領域に比例しない", t => {
  const f = operationsPolicyFixture(t); f.provision();
  // SQLite自身で小さなrowを逐次生成し、128MiBのfree pagesを残す。
  // JSには大きなBufferを作らず、sourceのschema/stateは元に戻す。
  f.db.exec(`CREATE TABLE backup_padding(bytes BLOB);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1024)
    INSERT INTO backup_padding SELECT zeroblob(131072) FROM n;
    DROP TABLE backup_padding;`);
  f.db.pragma("wal_checkpoint(TRUNCATE)");
  const sourceSize = fs.statSync(f.filename).size; assert.ok(sourceSize > 128 * 1024 * 1024);
  const before = process.resourceUsage().maxRSS;
  const operations = new ApprovalOperations(f.db, f.providers, scope);
  const recovery = new ApprovalBackupRestore(f.db, f.providers, scope, operations, f.policies, () => { throw Error("unused restore"); },
    { notification: () => notification, execution: () => executionKey });
  const destination = path.join(path.dirname(f.filename), "bounded.sqlite");
  assert.equal(recovery.backup(destination, 1).status, "backed_up");
  assert.ok(fs.statSync(destination).size < sourceSize / 16);
  assert.ok(process.resourceUsage().maxRSS - before < 64 * 1024, "backup memory exceeds bounded cache/row budget");
});
