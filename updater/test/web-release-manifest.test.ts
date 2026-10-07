import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseManifest } from "../src/validation.js";
import { manifest, targetSha } from "./helpers.js";

test("Web lockhashを保持し、旧releaseの照合と未知componentの拒否を維持する", () => {
  const old = manifest(targetSha);
  assert.deepEqual(parseReleaseManifest(old), old);
  const next = {...old, lock_hashes: {...old.lock_hashes, "sources/web": "d".repeat(64)}};
  assert.deepEqual(parseReleaseManifest(next), next);
  assert.throws(() => parseReleaseManifest({...next, lock_hashes: {...next.lock_hashes, "sources/web": "invalid"}}));
  assert.throws(() => parseReleaseManifest({...next, lock_hashes: {...next.lock_hashes, "sources/unknown": "e".repeat(64)}}));
});
