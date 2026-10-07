import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';
import type {UpdatePolicy} from './policy.js';import {sha256} from './validation.js';
interface Snapshot {version:1;from_sha:string;to_sha:string;original:string;target:string}
export interface HostTransition {digest:string;from_sha:string;to_sha:string}
interface Codec {decode(bytes:Buffer):Record<string,unknown>;encode(value:Record<string,unknown>):Buffer}
const codec:Codec={decode:b=>JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:b,encoding:'utf8'})),encode:v=>execFileSync('/usr/bin/plutil',['-convert','xml1','-o','-','-'],{input:JSON.stringify(v)})};
/** 初回だけexact旧plistをplan digestへ束縛する。署名policy一般のfallbackには使わない。 */
export class DispatcherHostTransition {
 private readonly directory:string;
 constructor(private readonly policy:UpdatePolicy,private readonly file=path.join(os.homedir(),'Library/LaunchAgents/dev.dona.dispatcher.plist'),private readonly plist=codec){this.directory=path.join(policy.control_root,'dispatcher-host-transitions');}
 private read(file:string):Buffer {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o022)||s.size>256*1024)throw Error('host_transition_file_invalid');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
 }
 private originalArgs(){return [this.policy.executables.node,path.join(this.policy.current_pointer,'dispatcher/dist/cli.js'),'serve'];}
 private targetArgs(){return [path.join(this.policy.current_pointer,'signed-host/DonaDispatcher.app/Contents/MacOS/DonaDispatcher'),'serve'];}
 private parse(s:Snapshot){for(const [value,args] of [[s.original,this.originalArgs()],[s.target,this.targetArgs()]] as const){const p=this.plist.decode(Buffer.from(value,'base64'));if(p.Label!=='dev.dona.dispatcher'||JSON.stringify(p.ProgramArguments)!==JSON.stringify(args))throw Error('host_transition_plist_invalid');}}
 plan(from:string,to:string):string|null {
  if(!this.policy.signed_host)return null;
  if(fs.existsSync(path.join(this.policy.release_root,from,'signed-host/DonaDispatcher.app')))return null;
  if(!/^[a-f0-9]{40}$/.test(from)||!/^[a-f0-9]{40}$/.test(to))throw Error('host_transition_sha_invalid');
  const original=this.read(this.file),p=this.plist.decode(original);
  if(p.Label!=='dev.dona.dispatcher'||JSON.stringify(p.ProgramArguments)!==JSON.stringify(this.originalArgs()))throw Error('host_transition_original_unverified');
  const target=this.plist.encode({...p,ProgramArguments:this.targetArgs()});
  const s:Snapshot={version:1,from_sha:from,to_sha:to,original:original.toString('base64'),target:target.toString('base64')};this.parse(s);
  const bytes=Buffer.from(JSON.stringify(s)),digest=sha256(bytes);
  fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const d=fs.lstatSync(this.directory);if(!d.isDirectory()||d.isSymbolicLink()||d.uid!==process.getuid?.()||(d.mode&0o077))throw Error('host_transition_directory_invalid');
  const file=path.join(this.directory,digest+'.json');if(fs.existsSync(file)){if(sha256(this.read(file))!==digest)throw Error('host_transition_snapshot_conflict');}
  else{const temporary=file+'.'+randomUUID();try{const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);if(sha256(this.read(file))!==digest)throw Error('host_transition_snapshot_conflict');const dir=fs.openSync(this.directory,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}finally{fs.rmSync(temporary,{force:true});}}
  return digest;
 }
 private snapshot(t:HostTransition):Snapshot {
  if(!/^[a-f0-9]{64}$/.test(t.digest))throw Error('host_transition_digest_invalid');
  const bytes=this.read(path.join(this.directory,t.digest+'.json'));if(sha256(bytes)!==t.digest)throw Error('host_transition_snapshot_invalid');
  const s=JSON.parse(bytes.toString()) as Snapshot;if(s.version!==1||s.from_sha!==t.from_sha||s.to_sha!==t.to_sha)throw Error('host_transition_scope_invalid');this.parse(s);return s;
 }
 verifyOriginal(t:HostTransition){const s=this.snapshot(t);if(!this.read(this.file).equals(Buffer.from(s.original,'base64')))throw Error('host_transition_original_drift');}
 apply(t:HostTransition,direction:'target'|'original',registered:boolean){
  const s=this.snapshot(t),old=Buffer.from(s.original,'base64'),next=Buffer.from(s.target,'base64'),desired=direction==='target'?next:old;
  const present=this.read(this.file);if(present.equals(desired))return;
  if(registered||(!present.equals(old)&&!present.equals(next)))throw Error('host_transition_live_or_drift');
  const temporary=this.file+'.'+randomUUID();try{const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,desired);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   if(!this.read(this.file).equals(present))throw Error('host_transition_compare_failed');fs.renameSync(temporary,this.file);
   const dir=fs.openSync(path.dirname(this.file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}if(!this.read(this.file).equals(desired))throw Error('host_transition_readback_unknown');
  }finally{fs.rmSync(temporary,{force:true});}
 }
}
