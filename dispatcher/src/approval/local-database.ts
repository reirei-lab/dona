import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {openSecurityDatabase} from '../audit/coordination.js';
import {assertSecurityDurability} from '../audit/durability.js';
import {verifyOpenDatabaseFile} from '../audit/file-identity.js';
import {installUsedTransactionNodeSchema} from './used-transaction-store.js';

/** Local production composition owns these connection settings. The generic
 * security opener remains verification-only and never provisions files. */
function openConfiguredDatabase(filename:string,initialNodes=false):Database.Database {
 const db=openSecurityDatabase(filename);
 try{
  if(initialNodes)db.pragma('journal_mode = WAL');
  else if(db.pragma('journal_mode',{simple:true})!=='wal')throw Error('local_approval_database_unverified');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  assertSecurityDurability(db);
  if(db.pragma('foreign_keys',{simple:true})!==1)throw Error('local_approval_database_unverified');
  verifyOpenDatabaseFile(db);
  return db;
 }catch{db.close();throw Error('local_approval_database_unverified');}
}
export function openLocalApprovalDatabase(filename:string):Database.Database {return openConfiguredDatabase(filename);}
/** Initial operator provisioning only. A partial file is retained for diagnosis;
 * neither failure nor a second call deletes/reinitializes an existing store. */
export function createLocalApprovalNodeDatabase(filename:string):Database.Database {
 if(!path.isAbsolute(filename)||path.normalize(filename)!==filename)throw Error('local_approval_nodes_path_invalid');
 for(let dir=path.dirname(filename);;dir=path.dirname(dir)){
  const info=fs.lstatSync(dir);
  if(!info.isDirectory()||info.isSymbolicLink()||![0,process.getuid?.()].includes(info.uid)||(info.mode&0o022)||(dir===path.dirname(filename)&&(info.uid!==process.getuid?.()||(info.mode&0o077))))throw Error('local_approval_nodes_path_invalid');
  if(dir===path.dirname(dir))break;
 }
 const fd=fs.openSync(filename,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
 try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const directory=fs.openSync(path.dirname(filename),fs.constants.O_RDONLY);try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
 const db=openConfiguredDatabase(filename,true);
 try{installUsedTransactionNodeSchema(db);return db;}
 catch{db.close();throw Error('local_approval_nodes_setup_incomplete');}
}
