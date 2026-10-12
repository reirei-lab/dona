/** 構造キー・enumを機密値と混同せず、人向け本文へのprivate値混入を検査する。 */
export function reportContainsPrivateValues(payload:unknown,objective:string,paths:readonly string[]):boolean {
 const strings=(value:unknown):string[]=>typeof value==="string"?[value]:Array.isArray(value)?value.flatMap(strings):value&&typeof value==="object"?Object.values(value).flatMap(strings):[];
 if(!payload||typeof payload!=="object"||Array.isArray(payload))return true;
 const values=strings(Object.fromEntries(Object.entries(payload).filter(([key])=>key!=="kind"&&key!=="severity")));
 return values.some(value=>value===objective||([...objective].length>=32&&value.includes(objective)))
  ||paths.some(secret=>secret&&values.some(value=>value.includes(secret)));
}
