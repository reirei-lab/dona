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
