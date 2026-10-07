#!/usr/bin/env node
// 署名・Keychain操作は行わない。専用の新規build directoryでのみsource buildする。
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const pin=JSON.parse(fs.readFileSync(path.join(root,'native/dispatcher-host/node-source.json'),'utf8'));
const [archive,directory,jobs='4']=process.argv.slice(2);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try {
  if(process.platform!=='darwin'||!archive||!directory||!path.isAbsolute(directory)||fs.existsSync(directory)||!/^([1-9]|1[0-6])$/.test(jobs))throw Error();
  const bytes=fs.readFileSync(archive);if(hash(bytes)!==pin.sha256)throw Error();
  fs.mkdirSync(directory,{mode:0o700});
  const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:process.env.HOME,TMPDIR:process.env.TMPDIR||'/tmp',LC_ALL:'C',LDFLAGS:'-framework Security -framework CoreFoundation'};
  const log=fs.openSync(path.join(directory,'build.log'),'wx',0o600);
  const run=(cmd,args,cwd=directory)=>{const r=spawnSync(cmd,args,{cwd,env,stdio:['ignore',log,log]});if(r.status!==0||r.error)throw Error();};
  run('/usr/bin/tar',['-xf',path.resolve(archive),'-C',directory]);
  const source=path.join(directory,`node-v${pin.version}`),main=fs.readFileSync(path.join(root,'native/dispatcher-host/main.cc'));
  const bootstrap=fs.readFileSync(path.join(root,'native/dispatcher-host/bootstrap.inc'));
  fs.writeFileSync(path.join(source,'src/node_main.cc'),main);
  fs.writeFileSync(path.join(source,'src/dona_host_bootstrap.h'),bootstrap);
  run('/usr/bin/python3',['configure','--without-npm','--without-corepack'],source);
  run('/usr/bin/make',[`-j${jobs}`],source);
  const binary=path.join(source,'out/Release/node');
  if(!fs.readFileSync(path.join(source,'src/node_main.cc')).equals(main)||!fs.readFileSync(path.join(source,'src/dona_host_bootstrap.h')).equals(bootstrap))throw Error();
  fs.closeSync(log);
  fs.copyFileSync(binary,path.join(directory,'DonaDispatcher'));fs.chmodSync(path.join(directory,'DonaDispatcher'),0o755);
  fs.writeFileSync(path.join(directory,'host-build.json'),JSON.stringify({schema_version:1,node:pin,host_source_sha256:hash(Buffer.concat([main,bootstrap])),binary_sha256:hash(fs.readFileSync(binary)),arch:process.arch})+'\n',{flag:'wx',mode:0o600});
  console.log('dispatcher_host_unsigned_build_complete');
}catch{console.error('dispatcher_host_build_failed');process.exitCode=1;}
