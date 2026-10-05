#!/usr/bin/env node
// 配備operatorが明示設定したidentityを使用する。開発testから実署名しない。
import fs from 'node:fs';import {randomUUID} from 'node:crypto';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {sha256} from './dispatcher-host-artifact.mjs';
const [release,configuration,cache]=process.argv.slice(2);
const root=fileURLToPath(new URL('../',import.meta.url));
try {
 if(process.platform!=='darwin'||![release,configuration,cache].every(v=>v&&path.isAbsolute(v)))throw Error();
 const stat=fs.lstatSync(configuration);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.nlink!==1)throw Error();
 const c=JSON.parse(fs.readFileSync(configuration,'utf8'));
 if(!/^[A-Z0-9]{10}$/.test(c.team_id)||!(/^[A-Z0-9]{10}\.dev\.dona\.approval$/).test(c.access_group)||!(/^[a-fA-F0-9]{40}$/).test(c.signing_identity_sha1)||!path.isAbsolute(c.provisioning_profile))throw Error();
 fs.mkdirSync(cache,{recursive:true,mode:0o700});const cs=fs.lstatSync(cache);if(!cs.isDirectory()||cs.isSymbolicLink()||cs.uid!==process.getuid()||(cs.mode&0o077))throw Error();
 const run=(cmd,args)=>{const r=spawnSync(cmd,args,{stdio:'inherit',env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME,TMPDIR:process.env.TMPDIR||'/tmp'}});if(r.status!==0||r.error)throw Error();};
 const pin=JSON.parse(fs.readFileSync(path.join(root,'native/dispatcher-host/node-source.json'),'utf8'));
 if(!/^24\.\d+\.\d+$/.test(pin.version)||pin.url!==`https://nodejs.org/dist/v${pin.version}/node-v${pin.version}.tar.xz`||!/^[a-f0-9]{64}$/.test(pin.sha256))throw Error();
 const inputs=Buffer.concat([Buffer.from(JSON.stringify(pin)),...['main.cc','bootstrap.inc'].map(n=>fs.readFileSync(path.join(root,'native/dispatcher-host',n)))]);
 const build=path.join(cache,'build-'+sha256(inputs)),archive=path.join(cache,'node-'+pin.version+'.tar.xz');
 if(!fs.existsSync(archive)){
   const response=await fetch(pin.url,{redirect:'error',signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error();
   const bytes=Buffer.from(await response.arrayBuffer());if(sha256(bytes)!==pin.sha256)throw Error();const temporary=archive+'.'+randomUUID();try{fs.writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});if(!fs.existsSync(archive))fs.renameSync(temporary,archive);}finally{fs.rmSync(temporary,{force:true});}
 }
 if(sha256(fs.readFileSync(archive))!==pin.sha256)throw Error();
 if(!fs.existsSync(build)){
   const temporary=build+'.'+randomUUID();
   try{run(process.execPath,[path.join(root,'scripts/build-dispatcher-host.mjs'),archive,temporary,'4']);fs.renameSync(temporary,build);}
   finally{fs.rmSync(temporary,{recursive:true,force:true});}
 }
 // 完成cacheのprovenance不一致は拒否し、自動上書きしない。
 const destination=path.join(release,'signed-host');
 run(process.execPath,[path.join(root,'scripts/package-dispatcher-host.mjs'),build,release,destination,c.provisioning_profile,c.team_id,c.access_group]);
 const app=path.join(destination,'DonaDispatcher.app');
 const macho=p=>{const fd=fs.openSync(p,'r'),b=Buffer.alloc(4);try{if(fs.readSync(fd,b,0,4,0)!==4)return false;}finally{fs.closeSync(fd);}return ['cffaedfe','cefaedfe','feedfacf','feedface','cafebabe','bebafeca'].includes(b.toString('hex'));};
 const visit=p=>{const s=fs.lstatSync(p);if(s.isSymbolicLink())throw Error();if(s.isDirectory()){for(const n of fs.readdirSync(p))visit(path.join(p,n));}else if(s.isFile()&&macho(p))run('/usr/bin/codesign',['--force','--sign',c.signing_identity_sha1,'--options','runtime','--timestamp',p]);};
 visit(path.join(app,'Contents/Resources'));
 run(process.execPath,[path.join(root,'scripts/refresh-dispatcher-host-native-manifests.mjs'),app]);
 run('/usr/bin/codesign',['--force','--sign',c.signing_identity_sha1,'--options','runtime','--timestamp','--entitlements',path.join(destination,'host.entitlements.plist'),app]);
 run(process.execPath,[path.join(root,'scripts/doctor-dispatcher-host.mjs'),app,c.team_id,c.access_group]);
 console.log('signed_dispatcher_host_prepared');
}catch{console.error('signed_dispatcher_host_prepare_failed');process.exitCode=1;}
