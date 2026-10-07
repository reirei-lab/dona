/** 署名host専用の固定smoke入口。引数・設定・DB file・Keychain APIを使わない。 */
import {createRequire} from 'node:module';
import Database from 'better-sqlite3';

try {
  if (process.argv.length !== 2) throw Error();
  const db = new Database(':memory:');
  try { if (db.prepare('SELECT 1').pluck().get() !== 1) throw Error(); }
  finally { db.close(); }
  // require時にnative addonをロードする。credential APIは呼ばない。
  const sibling = createRequire(new URL('../../sources/slack/package.json', import.meta.url));
  const keytar = sibling('@github/keytar') as {getPassword?:unknown};
  if (typeof keytar.getPassword !== 'function') throw Error();
  console.log(JSON.stringify({native:'verified',sqlite:'loaded',keytar:'loaded'}));
} catch {
  console.error('dispatcher_host_native_unverified');
  process.exitCode = 1;
}
