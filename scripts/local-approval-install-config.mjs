import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

function privateFile(file, limit) {
  if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file)throw Error();
  for(let dir=path.dirname(file);;dir=path.dirname(dir)){
    const s=fs.lstatSync(dir);
    if(!s.isDirectory()||s.isSymbolicLink()||![0,process.getuid()].includes(s.uid)||(s.mode&0o022))throw Error();
    if(dir===path.dirname(dir))break;
  }
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o077)||s.size>limit)throw Error();return fs.readFileSync(fd);}
  finally{fs.closeSync(fd);}
}
/** 明示入力が優先。未指定時は同じgenerationの既存plistだけを保持する。 */
export function resolveLocalApprovalInstallConfig(explicit, installedPlist, configRoot) {
  try{
    let selected=explicit||undefined;
    if(!selected&&installedPlist){
      let exists=true;try{fs.lstatSync(installedPlist);}catch(e){if(e.code==='ENOENT')exists=false;else throw e;}
      if(exists){
        const bytes=privateFile(installedPlist,1024*1024);
        const old=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:bytes,encoding:'utf8'}));
        const env=old.EnvironmentVariables;
        if(old.Label!=='dev.dona.dispatcher'||!env||typeof env!=='object')throw Error();
        if(env.DONA_LOCAL_APPROVAL_CONFIG!==undefined){
          if(env.DOTENV_CONFIG_PATH!==path.join(configRoot,'dispatcher.env'))throw Error();
          selected=env.DONA_LOCAL_APPROVAL_CONFIG;
        }
      }
    }
    if(selected!==undefined){
      const data=JSON.parse(privateFile(selected,16384).toString('utf8'));
      if(!data||typeof data!=='object'||Array.isArray(data))throw Error();
    }
    return selected;
  }catch{throw Error('local_approval_install_config_invalid');}
}
