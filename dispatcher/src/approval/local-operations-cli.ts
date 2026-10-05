import path from "node:path";
import {createHash,createHmac} from "node:crypto";
import {createInterface} from "node:readline/promises";
import {openLocalApprovalDatabase} from "./local-database.js";
import {NativeLocalApprovalConnection,readLocalApprovalNativeConfig} from "./local-native.js";
import {LocalApprovalOperations} from "./local-operations.js";
import {LocalApprovalBackup} from "./local-backup.js";
import {localApprovalCredential} from "./local-credential.js";
import {LocalSlackApprovalProvider} from "./local-slack-provider.js";
import {stableStringify} from "../validation.js";
const operations=["health","list","sweep","retention","reconcile","backup","restore-check","restore"] as const;
export function parseLocalOperationsArguments(args:string[]){
 const flags:Record<string,string>={};for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!key||!value||value.startsWith("--")||flags[key]||!["--operation","--config","--database","--handle","--owner-kind","--reason","--cursor","--limit","--destination","--candidate","--apply"].includes(key))throw Error("invalid_arguments");flags[key]=value;}
 const operation=flags["--operation"];if(!operations.includes(operation as any)||!flags["--config"]||!flags["--database"])throw Error("invalid_arguments");
 const allowed:Record<string,string[]>={health:[],list:["--cursor","--limit"],sweep:["--apply"],retention:["--owner-kind","--handle","--apply"],reconcile:["--handle","--reason","--apply"],backup:["--destination","--apply"],"restore-check":["--candidate"],restore:["--candidate","--destination","--apply"]};
 for(const key of Object.keys(flags))if(!["--operation","--config","--database",...allowed[operation!]!].includes(key))throw Error("invalid_arguments");
 for(const key of ["--config","--database","--destination","--candidate"])if(flags[key]&&(!path.isAbsolute(flags[key]!)||path.normalize(flags[key]!)!==flags[key]))throw Error("invalid_arguments");
 for(const key of ["--handle","--cursor"])if(flags[key]&&!/^[A-Za-z0-9_-]{1,128}$/.test(flags[key]!))throw Error("invalid_arguments");
 if(flags["--apply"]&&flags["--apply"]!=="yes"||flags["--limit"]&&(!/^[1-9][0-9]*$/.test(flags["--limit"]!)||Number(flags["--limit"])>100))throw Error("invalid_arguments");
 const required:Record<string,string[]>={retention:["--owner-kind","--handle"],reconcile:["--handle","--reason"],backup:["--destination"],"restore-check":["--candidate"],restore:["--candidate","--destination"]};
 if((required[operation!]??[]).some(k=>!flags[k])||operation==="retention"&&!["request","attempt"].includes(flags["--owner-kind"]!))throw Error("invalid_arguments");
 if(flags["--reason"]&&(flags["--reason"]!.trim().length<8||flags["--reason"]!.length>512))throw Error("invalid_arguments");return {operation:operation as typeof operations[number],flags,apply:flags["--apply"]==="yes"};
}
/** 固定signed hostのoperations entry。全エラーをredactし、pathやreasonをstdoutへ出さない。 */
export async function localOperationsMain(args:string[]){let db:ReturnType<typeof openLocalApprovalDatabase>|undefined,native:NativeLocalApprovalConnection|undefined;
 try{const {operation,flags,apply}=parseLocalOperationsArguments(args),config=readLocalApprovalNativeConfig(flags["--config"]!);db=openLocalApprovalDatabase(flags["--database"]!);
  const currentOwner=()=>{const row=db!.prepare("SELECT instance_id,owner_id FROM dashboard_operator_identity WHERE singleton=1").get() as {instance_id:string;owner_id:string}|undefined;return process.getuid?.()===process.geteuid?.()&&row?.instance_id===config.scope.instance_id&&row.owner_id===config.owner_id;};
  if(!currentOwner())throw Error();native=new NativeLocalApprovalConnection(db,config);if(!native.doctor().ready)throw Error();
  const operator={owner_id:config.owner_id,authorize:()=>{try{native!.maintenance.requireReady(config.key_version);return currentOwner()&&stableStringify(readLocalApprovalNativeConfig(flags["--config"]!))===stableStringify(config);}catch{return false;}}};
  let slack:{reconcile:LocalSlackApprovalProvider["reconcile"]}={reconcile:async()=>{throw Error("provider_not_requested");}};
  if(operation==="reconcile"){const credentials=await localApprovalCredential(config.slack_workspace_alias),revision=createHmac("sha256",native.keys.content(null).secret).update("dona.local-approval.thread-revision.v1").digest();const provider=new LocalSlackApprovalProvider(config.scope.workspace_id,credentials,revision);slack={reconcile:(...input)=>provider.reconcile(...input)};}
  const ops=new LocalApprovalOperations(db,native.providers,config.scope,native.keys,operator,slack),backup=new LocalApprovalBackup(db,native.providers,config,operator);
  if(operation==="health"){console.log(JSON.stringify(ops.health()));return;}if(operation==="list"){console.log(JSON.stringify(ops.list(flags["--cursor"]??null,Number(flags["--limit"]??50))));return;}if(operation==="restore-check"){console.log(JSON.stringify(backup.check(flags["--candidate"]!)));return;}
  const sweepPreview=()=>({operation:"sweep",confirmation:createHash("sha256").update(stableStringify([config, native!.providers.auditAnchors.read(),native!.providers.clockMarks.read()])).digest("hex"),health:ops.health()});
  const preview=operation==="retention"?ops.previewRetention(flags["--owner-kind"] as "request"|"attempt",flags["--handle"]!):operation==="reconcile"?await ops.previewReconcile(flags["--handle"]!,flags["--reason"]!):operation==="backup"?backup.preview(flags["--destination"]!):operation==="restore"?backup.restorePreview(flags["--candidate"]!,flags["--destination"]!):sweepPreview();
  if(!apply){console.log(JSON.stringify({dry_run:true,...preview}));return;}
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw Error("operator_tty_required");console.log(JSON.stringify(preview));const exact=`${config.scope.instance_id}/${config.scope.workspace_id}/${config.owner_id}:${operation}:${preview.confirmation}`;
  const reader=createInterface({input:process.stdin,output:process.stdout});let answer:string;try{answer=await reader.question(`対象と結果候補を確認し、次の確認値を入力してください: ${exact}\n> `);}finally{reader.close();}if(answer!==exact||!operator.authorize())throw Error("operator_confirmation_required");
  const result=operation==="retention"?ops.retain(flags["--owner-kind"] as "request"|"attempt",flags["--handle"]!,preview.confirmation):operation==="reconcile"?ops.applyReconcile(preview.confirmation):operation==="backup"?backup.backup(flags["--destination"]!,preview.confirmation):operation==="restore"?backup.restore(flags["--candidate"]!,flags["--destination"]!,preview.confirmation):(()=>{if(sweepPreview().confirmation!==preview.confirmation)throw Error("confirmation_stale");return ops.sweep();})();console.log(JSON.stringify(result));
 }catch{console.error(JSON.stringify({safe_ready:false,reason:"local_approval_operations_unverified"}));process.exitCode=1;}finally{native?.close();db?.close();}
}
