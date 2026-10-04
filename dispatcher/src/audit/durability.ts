import type Database from "better-sqlite3";

/** Security writes require file-backed WAL and a synchronous commit. This only
 * verifies the connection; it never changes journal mode or repairs a database. */
export function assertSecurityDurability(db: Database.Database): void {
  if (!db.open || db.memory || db.readonly || db.pragma("main.journal_mode", { simple: true }) !== "wal"
    || ![2, 3].includes(db.pragma("main.synchronous", { simple: true }) as number)) {
    throw new Error("security_durability_unverified");
  }
}

/** restoreのstandalone read-only imageはcommitしない。通常接続のwrite要件を
 * 緩めず、保存層のread admissionだけを分離する。 */
export function assertSecurityReadAdmission(db: Database.Database): void {
  if (db.readonly) {
    if (!db.open || db.memory || db.pragma("main.journal_mode", { simple: true }) !== "delete") throw new Error("security_read_unverified");
  } else assertSecurityDurability(db);
}
