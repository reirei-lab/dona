import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { parseKeychainCasResponse } from "./keychain-cas.js";
interface BindingKeychainTransport {exchange(request:string):string}

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
/** 固定in-process native port。CLIはraw CASを公開しない。署名・entitlement・
 * provisionは別のdeployment gateであり、このconstructorでは変更しない。 */
export class NativeKeychainPort implements BindingKeychainTransport {
  private readonly db: Database.Database;
  constructor() {
    let db: Database.Database | undefined;
    try {
      if (process.platform !== "darwin" || process.getuid?.() !== process.geteuid?.()) throw Error();
      const directory = new URL("../../dist/native/", import.meta.url);
      const library = new URL("security-keychain-port.dylib", directory), manifest = new URL("security-keychain-port.json", directory);
      const source = new URL("../../src/native/security-keychain-cas.m", import.meta.url), port = new URL("../../src/native/security-keychain-port.m", import.meta.url);
      const header = new URL("../../src/native/security-keychain-cas.h", import.meta.url);
      const headers = [new URL("../../node_modules/better-sqlite3/deps/sqlite3/sqlite3.h", import.meta.url), new URL("../../node_modules/better-sqlite3/deps/sqlite3/sqlite3ext.h", import.meta.url)];
      for (const file of [library, manifest, source, port, header, ...headers]) {
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o022) !== 0 || info.size > 16 * 1024 * 1024) throw Error();
      }
      const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const expected = { codec_version: 1, platform: process.platform, arch: process.arch,
        source: hash(fs.readFileSync(source)), port: hash(fs.readFileSync(port)), header: hash(fs.readFileSync(header)),
        sqlite_headers: hash(Buffer.concat(headers.map(file => fs.readFileSync(file)))), binary: hash(fs.readFileSync(library)) };
      if (JSON.stringify(value) !== JSON.stringify(expected)) throw Error();
      db = new Database(":memory:"); db.loadExtension(fileURLToPath(library)); this.db = db;
    } catch { db?.close(); throw Error("approval_native_keychain_unavailable"); }
  }
  exchange(request: string): string {
    try {
      if (typeof request !== "string" || Buffer.byteLength(request) > 32768) throw Error();
      const response = this.db.prepare("SELECT dona_keychain_exchange(?)").pluck().get(request);
      if (typeof response !== "string") throw Error(); parseKeychainCasResponse(response); return response;
    } catch { throw Error("approval_native_keychain_unavailable"); }
  }
  provision(scope:import("./keychain-cas.js").KeychainCasScope,value:Uint8Array):void {
    if(!process.stdin.isTTY||process.getuid?.()!==process.geteuid?.())throw Error("approval_local_operator_required");
    const response=parseKeychainCasResponse(this.db.prepare("SELECT dona_keychain_provision(?)").pluck().get(JSON.stringify({codec_version:1,scope,value:Buffer.from(value).toString("base64")})) as string);
    if(response.status!=="changed"||response.revision!==1)throw Error("approval_provision_unverified");
  }
  close(): void { this.db.close(); }
}
