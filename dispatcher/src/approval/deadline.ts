/** 読み取り・authority再観測のdeadline。遅い結果は送信許可へ戻さない。 */
export function approvalDeadline<T>(operation:()=>T|Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();
 return new Promise<T>((resolve,reject)=>{
  const cleanup=()=>signal.removeEventListener("abort",abort);
  const abort=()=>{cleanup();reject(signal.reason);};
  signal.addEventListener("abort",abort,{once:true});
  Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}).then(
   value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
 });
}
