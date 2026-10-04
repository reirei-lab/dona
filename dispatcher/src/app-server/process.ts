import { execFileSync } from "node:child_process";

export interface ProcessIdentity {pid:number;parent:number;group:number;uid:number;start:string;state:string}
export function processes():ProcessIdentity[] {
  return execFileSync("/bin/ps",["-axo","pid=,ppid=,pgid=,uid=,lstart=,stat="],{encoding:"utf8",timeout:10_000}).trim().split("\n").map(line=>{
    const p=line.trim().split(/\s+/);if(p.length!==10)throw Error("runtime_process_sample_invalid");
    return {pid:Number(p[0]),parent:Number(p[1]),group:Number(p[2]),uid:Number(p[3]),start:p.slice(4,9).join(" "),state:p[9]!};
  });
}
export function identity(pid:number):ProcessIdentity|undefined{return processes().find(p=>p.pid===pid);}
export function same(a:ProcessIdentity,b:ProcessIdentity|undefined):boolean{return !!b&&a.pid===b.pid&&a.uid===b.uid&&a.start===b.start;}
export const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

/** 親から凍結し、forkを止めてから子を採取する。各signalは開始identityを再照合する。 */
export async function stopTree(root:ProcessIdentity,save:(rows:ProcessIdentity[])=>void):Promise<void> {
  if(root.uid!==process.getuid?.()||root.pid===process.pid)throw Error("runtime_process_scope");
  const captured=new Map<number,ProcessIdentity>();
  const visit=async(row:ProcessIdentity):Promise<void>=>{
    const fresh=identity(row.pid);if(!same(row,fresh)||fresh!.state.includes("Z"))return;
    captured.set(row.pid,row);save([...captured.values()]);
    process.kill(row.pid,"SIGSTOP");
    for(const child of processes().filter(p=>p.parent===row.pid)) {
      if(child.uid!==root.uid)throw Error("runtime_child_owner_changed");
      await visit(child);
    }
  };
  await visit(root);
  if(!captured.has(root.pid))throw Error("runtime_process_stop_evidence_missing");
  for(const row of [...captured.values()].reverse()) {
    if(same(row,identity(row.pid)))try{process.kill(row.pid,"SIGKILL");}catch(error){if((error as NodeJS.ErrnoException).code!=="ESRCH")throw error;}
  }
  for(let i=0;i<100;i++) {
    const table=processes();
    if([...captured.values()].every(row=>{const p=table.find(p=>p.pid===row.pid);return !same(row,p)||p!.state.includes("Z");}))return;
    await sleep(50);
  }
  throw Error("runtime_process_stop_unconfirmed");
}
