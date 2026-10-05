import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

if (process.platform === "darwin") {
  const root = fileURLToPath(new URL("../", import.meta.url)), directory = path.join(root, "dist/native");
  const port = path.join(root, "src/native/security-keychain-port.m"), source = path.join(root, "src/native/security-keychain-cas.m");
  const header = path.join(root, "src/native/security-keychain-cas.h"), include = path.join(root, "node_modules/better-sqlite3/deps/sqlite3");
  const target = path.join(directory, "security-keychain-port.dylib"), manifest = path.join(directory, "security-keychain-port.json");
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const inputs = { codec_version: 1, platform: process.platform, arch: process.arch,
    source: hash(fs.readFileSync(source)), port: hash(fs.readFileSync(port)), header: hash(fs.readFileSync(header)),
    sqlite_headers: hash(Buffer.concat([fs.readFileSync(path.join(include, "sqlite3.h")), fs.readFileSync(path.join(include, "sqlite3ext.h"))])) };
  if (!["arm64", "x64"].includes(process.arch)) throw Error("keychain_port_platform_unavailable");
  let current = false;
  try { const info = fs.lstatSync(target); current = info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o022) === 0
    && JSON.stringify(JSON.parse(fs.readFileSync(manifest, "utf8"))) === JSON.stringify({ ...inputs, binary: hash(fs.readFileSync(target)) }); } catch { /* rebuild */ }
  if (!current) {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = target + "." + randomUUID(), temporaryManifest = manifest + "." + randomUUID();
    try {
      const result = spawnSync("/usr/bin/cc", ["-arch", process.arch === "x64" ? "x86_64" : "arm64", "-dynamiclib", "-fobjc-arc", "-O2", "-Wall", "-Wextra", "-Werror",
        "-I", include, "-framework", "Foundation", "-framework", "Security", "-framework", "LocalAuthentication", source, port, "-o", temporary],
        { shell: false, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 30000, maxBuffer: 8192 });
      if (result.error || result.status !== 0 || result.signal !== null) throw Error("keychain_port_build_failed");
      fs.chmodSync(temporary, 0o644);
      fs.writeFileSync(temporaryManifest, JSON.stringify({ ...inputs, binary: hash(fs.readFileSync(temporary)) }) + "\n", { flag: "wx", mode: 0o644 });
      fs.renameSync(temporary, target); fs.renameSync(temporaryManifest, manifest);
    } finally { fs.rmSync(temporary, { force: true }); fs.rmSync(temporaryManifest, { force: true }); }
  }
}
