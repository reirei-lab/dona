import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';import Database from 'better-sqlite3';
import {tempPolicy,removeTree} from './helpers.js';import {parsePolicy} from '../src/policy.js';import {taskGenerationPolicy,isTaskGenerationRollout,sameTaskGeneration} from '../src/task-generation-update.js';
const execute=promisify(execFile);
test('Task世代policyとrolloutはexact契約を検証しdowngradeを許可しない',async()=>{
 const f=await tempPolicy();try{
 assert.deepEqual(parsePolicy({...f.policy,task_generation_update:taskGenerationPolicy}).task_generation_update,taskGenerationPolicy);
 for(const value of [{...taskGenerationPolicy,schema:3},{...taskGenerationPolicy,mode:'rollback'},{...taskGenerationPolicy,restore_database:true}])assert.throws(()=>parsePolicy({...f.policy,task_generation_update:value}));
 const {schema_version:_,...c}=JSON.parse(await fs.readFile(new URL('../../config/release-compatibility.json',import.meta.url),'utf8'));const rollout=JSON.parse(await fs.readFile(new URL('../../config/schema-rollout.json',import.meta.url),'utf8'));
 assert.ok(isTaskGenerationRollout(rollout));assert.equal(isTaskGenerationRollout({...rollout,online_migration:true}),false);assert.ok(sameTaskGeneration(c,c));assert.equal(sameTaskGeneration({...c,app_schema_write:3},c),false);assert.equal(sameTaskGeneration(c,{...c,app_schema_read_max:5}),false);
 }finally{await removeTree(f.root);}
});
test('実schema4 SQLiteの停止前検査は保護payloadを出力/backup/変更しない',async()=>{
 const f=await tempPolicy();try{
 const dbfile=path.join(f.root,'dispatcher.db'),db=new Database(dbfile);db.exec("PRAGMA user_version=4;CREATE TABLE protected_payload(id INTEGER PRIMARY KEY,secret TEXT NOT NULL);INSERT INTO protected_payload(secret) VALUES ('private-sentinel');");db.close();await fs.chmod(dbfile,0o600);const before=await fs.readFile(dbfile);
 const script=fileURLToPath(new URL('../src/app-schema-inspect-cli.ts',import.meta.url));const result=await execute(process.execPath,['--import','tsx',script,dbfile],{cwd:fileURLToPath(new URL('..',import.meta.url))});
 assert.deepEqual(JSON.parse(result.stdout),{schema_version:1,user_version:4,integrity_ok:true,foreign_key_violations:0});assert.equal(result.stdout.includes('private-sentinel'),false);assert.deepEqual(await fs.readFile(dbfile),before);assert.deepEqual((await fs.readdir(f.root)).filter(x=>/backup|snapshot|restore/.test(x)),[]);
 }finally{await removeTree(f.root);}
});
