import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("../scripts/write-release-manifest.mjs", import.meta.url);
test("release manifest は Web lockfile を含め、欠落時は公開しない", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-web-release-"));
  try {
    fs.mkdirSync(path.join(root, "config"));
    fs.writeFileSync(path.join(root, "config/release-compatibility.json"), JSON.stringify({schema_version: 1, protocol: 1}));
    for (const component of ["dispatcher", "sources/slack", "updater"]) {
      fs.mkdirSync(path.join(root, component), {recursive: true});
      fs.writeFileSync(path.join(root, component, "package-lock.json"), "{}");
    }
    const run = () => spawnSync(process.execPath, [script.pathname, root, "a".repeat(40), "11.0.0", "1"], {encoding: "utf8"});
    assert.notEqual(run().status, 0);
    assert.equal(fs.existsSync(path.join(root, "release-manifest.json")), false);
    fs.mkdirSync(path.join(root, "sources/web"));
    const lock = '{"name":"web"}';
    fs.writeFileSync(path.join(root, "sources/web/package-lock.json"), lock);
    assert.equal(run().status, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "release-manifest.json"), "utf8"));
    assert.equal(manifest.lock_hashes["sources/web"], createHash("sha256").update(lock).digest("hex"));
    assert.deepEqual(Object.keys(manifest.lock_hashes).sort(), ["dispatcher", "sources/slack", "sources/web", "updater"]);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});


test("installer は Web CI の成功を必須にする", () => {
  const installer = fs.readFileSync(new URL("../scripts/install-self-update.sh", import.meta.url), "utf8");
  const validator = installer.match(/\$NODE_PATH -e '(\nconst runs = JSON.parse[\s\S]*?)' "\$INSTALL_TMP\/check-runs.json"/)[1];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dona-web-install-ci-"));
  const sha = "b".repeat(40);
  const checks = ["Verify dispatcher", "Verify sources/slack", "Verify updater", "Verify self-hosted macOS", "Verify sources/web"];
  try {
    const file = path.join(root, "checks.json");
    for (const state of ["success", "missing", "failure", "skipped", "in_progress"]) {
      const runs = checks.filter(name => state !== "missing" || name !== "Verify sources/web").map((name, id) => ({
        name, id, head_sha: sha, app: {slug: "github-actions"},
        status: name === "Verify sources/web" && state === "in_progress" ? state : "completed",
        conclusion: name === "Verify sources/web" ? state : "success",
      }));
      fs.writeFileSync(file, JSON.stringify({check_runs: runs}));
      const result = spawnSync(process.execPath, ["-e", validator, file, sha], {encoding: "utf8"});
      assert.equal(result.status === 0, state === "success", state);
    }
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
