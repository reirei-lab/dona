import fs from "node:fs";
import path from "node:path";
export interface DashboardRelease {root:string;sha:string}
/** The optional pointer belongs to the already installed updater runtime. This
 * function cannot select a repository/ref or activate a release. */
export function readDashboardRelease(pointer:string):DashboardRelease {
 try {
  const uid=process.getuid?.(),parent=path.dirname(pointer);
  if(uid===undefined||!path.isAbsolute(pointer)||path.normalize(pointer)!==pointer||path.basename(pointer)!=='current'||fs.realpathSync(parent)!==parent)throw Error();
  const directory=fs.lstatSync(parent),link=fs.lstatSync(pointer);
  if(!directory.isDirectory()||directory.uid!==uid||(directory.mode&0o777)!==0o700||!link.isSymbolicLink()||link.uid!==uid)throw Error();
  const root=fs.realpathSync(pointer),sha=path.basename(root),releases=path.join(parent,'releases');
  if(!/^[a-f0-9]{40}$/.test(sha)||path.dirname(root)!==releases||fs.realpathSync(releases)!==releases)throw Error();
  for(const file of [releases,root]){const info=fs.lstatSync(file);if(!info.isDirectory()||info.uid!==uid||(info.mode&0o022))throw Error();}
  for(const file of ['release-manifest.json','dispatcher/dist/dashboard/cli.js','sources/web/dist/observer-dashboard.js']){
   const target=path.join(root,file),info=fs.lstatSync(target);
   if(!info.isFile()||info.isSymbolicLink()||info.uid!==uid||(info.mode&0o022)||info.nlink!==1||fs.realpathSync(target)!==target)throw Error();
  }
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'release-manifest.json'),'utf8')) as {sha?:unknown;lock_hashes?:Record<string,unknown>};
  if(manifest.sha!==sha||typeof manifest.lock_hashes?.['sources/web']!=='string'||!/^[a-f0-9]{64}$/.test(manifest.lock_hashes['sources/web']))throw Error();
  const after=fs.lstatSync(pointer);if(after.dev!==link.dev||after.ino!==link.ino||fs.realpathSync(pointer)!==root)throw Error();
  return {root,sha};
 }catch{throw Error('dashboard_release_pointer_unverified');}
}
/** One shutdown only, including broken/unsupported rollback pointers. No worker
 * control, DB write or updater operation is reachable through this watcher. */
export function watchDashboardRelease(pointer:string,expectedSha:string,stop:()=>Promise<void>,intervalMs=1000):()=>void {
 let stopping=false;
 const timer=setInterval(()=>{
  if(stopping)return;
  try{if(readDashboardRelease(pointer).sha===expectedSha)return;}catch{/* Fail closed on missing/unknown target. */}
  stopping=true;clearInterval(timer);void stop().catch(()=>{});
 },intervalMs);timer.unref();
 return()=>{stopping=true;clearInterval(timer);};
}
