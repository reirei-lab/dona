import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import Database from 'better-sqlite3';
const require=createRequire(import.meta.url);
const script=fileURLToPath(new URL('../../scripts/maintenance/reset_upgrade.py',import.meta.url));
const program=`import importlib.util,sys
spec=importlib.util.spec_from_file_location('maintenance',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.NodeDatabase(sys.argv[2],sys.argv[3]).backup(sys.argv[4],sys.argv[5])`;
for(const kind of ['plain','payload','renamed','dropped','legacy'] as const)test(`保守snapshotは保護payload履歴を複製しない: ${kind}`,t=>{
 const dir=mkdtempSync(join(tmpdir(),'dona-backup-boundary-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const source=join(dir,'source.sqlite'),target=join(dir,'backup.sqlite');
 const db=new Database(source);db.pragma('journal_mode=WAL');db.exec("CREATE TABLE tasks(id TEXT); INSERT INTO tasks VALUES('retained')");
 if(kind!=='plain'){
  db.exec('CREATE TABLE approval_payload_secrets(body TEXT)');db.prepare('INSERT INTO approval_payload_secrets VALUES(?)').run('PRIVATE-DRAFT-'.repeat(500));
  if(kind!=='legacy')db.pragma('application_id=1146048080');
  if(kind==='renamed')db.exec('ALTER TABLE approval_payload_secrets RENAME TO history');
  if(kind==='dropped')db.exec('DROP TABLE approval_payload_secrets');
 }
 const result=spawnSync('python3',['-B','-c',program,script,process.execPath,require.resolve('better-sqlite3'),source,target],{encoding:'utf8',timeout:10000});
 db.close();
 if(kind==='plain'){assert.equal(result.status,0,result.stderr);const backup=new Database(target,{readonly:true});assert.equal(backup.prepare('SELECT id FROM tasks').pluck().get(),'retained');backup.close();}
 else {assert.notEqual(result.status,0);assert.match(result.stderr,/command_failed: node/);assert.equal(existsSync(target),false);}
});
