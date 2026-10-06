#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { waitForUpdaterIdentity } from "./self-update-install-preflight.mjs";
import { controlUpdaterTreeDigest } from "./control-updater-tree.mjs";

export async function writeControlReceipt(attemptDirectory, output, expectedSha, controlUpdaterRoot, socketPath, domain, options = {}) {
  if (!path.isAbsolute(attemptDirectory ?? "") || !path.isAbsolute(output ?? "") ||
      path.dirname(output) !== path.dirname(controlUpdaterRoot ?? "") ||
      !path.isAbsolute(controlUpdaterRoot ?? "") ||
      socketPath !== path.join(path.dirname(controlUpdaterRoot), "updater.sock") ||
      !/^gui\/[1-9][0-9]*$/.test(domain ?? "") ||
      !/^[0-9a-f]{40}$/.test(expectedSha ?? "") ||
      !/^[0-9a-f]{40}\.[A-Za-z0-9]+$/.test(path.basename(attemptDirectory))) {
    throw new Error("control receipt arguments are invalid");
  }
  for (const directory of [attemptDirectory, path.dirname(output)]) {
    const stats = fs.lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid() ||
        (stats.mode & 0o077) !== 0) throw new Error("control receipt directory is not owner-private");
  }
  const attemptFile = path.join(attemptDirectory, "attempt.json");
  const attemptStats = fs.lstatSync(attemptFile);
  if (!attemptStats.isFile() || attemptStats.isSymbolicLink() || attemptStats.uid !== process.getuid() ||
      attemptStats.nlink !== 1 || (attemptStats.mode & 0o077) !== 0) {
    throw new Error("control attempt ledger is not owner-private");
  }
  const bytes = fs.readFileSync(attemptFile);
  const attempt = JSON.parse(bytes.toString("utf8"));
  if (attempt.schema_version !== 1 || attempt.phase !== "verified" || attempt.new_build_sha !== expectedSha ||
      !/^[0-9a-f]{64}$/.test(attempt.db_backup_sha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(attempt.restore_rehearsal_sha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(attempt.release_tree_sha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(attempt.new_policy_sha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(attempt.new_plist_sha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(attempt.new_dispatcher_plist_sha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(attempt.old_updater_tree_sha256 ?? "")) {
    throw new Error("control attempt is not verified");
  }
  const newUpdaterTreeSha256 = controlUpdaterTreeDigest(controlUpdaterRoot);
  if (!/^[0-9a-f]{64}$/.test(attempt.new_updater_tree_sha256 ?? "") ||
      newUpdaterTreeSha256 !== attempt.new_updater_tree_sha256) {
    throw new Error("installed updater differs from the verified release");
  }
  const oldUpdaterTreeSha256 = controlUpdaterTreeDigest(path.join(attemptDirectory, "updater.previous"));
  if (oldUpdaterTreeSha256 !== attempt.old_updater_tree_sha256) {
    throw new Error("restore updater differs from the saved control attempt");
  }
  // Observe twice around the artifact check. A socket replacement or restarted process
  // must not inherit an observation made for a different process. No service writes occur here.
  const observe = () => waitForUpdaterIdentity(socketPath, expectedSha, domain, 2_000,
    { ...options, allowLegacyHealth: false, expectedUpdateSchema: 3 });
  const processIdentity = await observe();
  if (!fs.readFileSync(attemptFile).equals(bytes) ||
      controlUpdaterTreeDigest(controlUpdaterRoot) !== newUpdaterTreeSha256) {
    throw new Error("control artifacts changed during process observation");
  }
  const confirmedIdentity = await observe();
  if (JSON.stringify(processIdentity) !== JSON.stringify(confirmedIdentity) ||
      !fs.readFileSync(attemptFile).equals(bytes) ||
      controlUpdaterTreeDigest(controlUpdaterRoot) !== newUpdaterTreeSha256 ||
      controlUpdaterTreeDigest(path.join(attemptDirectory, "updater.previous")) !== oldUpdaterTreeSha256) {
    throw new Error("control process identity changed before receipt publication");
  }
  const receipt = {
    schema_version: 1,
    build_sha: expectedSha,
    schema_migration_capability: "dispatcher_v2_to_v3_online_backup_v1",
    attempt_id: path.basename(attemptDirectory),
    attempt_sha256: createHash("sha256").update(bytes).digest("hex"),
    old_build_sha: attempt.old_build_sha,
    policy_sha256: attempt.new_policy_sha256,
    plist_sha256: attempt.new_plist_sha256,
    dispatcher_plist_sha256: attempt.new_dispatcher_plist_sha256,
    db_backup_sha256: attempt.db_backup_sha256,
    release_tree_sha256: attempt.release_tree_sha256,
    control_updater_tree_sha256: newUpdaterTreeSha256,
    old_updater_tree_sha256: oldUpdaterTreeSha256,
    restore_rehearsal_sha256: attempt.restore_rehearsal_sha256,
    process_identity: processIdentity,
    verified_at: new Date().toISOString(),
  };
  const fd = fs.openSync(output, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(receipt)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 8) throw new Error("control receipt arguments are invalid");
    await writeControlReceipt(...process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
