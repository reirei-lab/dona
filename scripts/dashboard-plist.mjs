import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

/** Same-directory atomic publication. A killed earlier installer may leave its
 * own temporary file, but it cannot reserve the next install's temporary name. */
export function writeDashboardPlist(file, body) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  const owned = fs.fstatSync(descriptor);
  try {
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
    fs.renameSync(temporary, file);
  } finally {
    fs.closeSync(descriptor);
    // Never reclaim a pathname replaced by another actor, or an older install's file.
    let current;
    try { current = fs.lstatSync(temporary); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current?.isFile() && current.uid === owned.uid && current.nlink === 1
      && current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(temporary);
  }
}
