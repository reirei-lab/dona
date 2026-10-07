import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
const absolute = z.string().max(1024).refine(value=>path.isAbsolute(value)&&path.normalize(value)===value&&!value.includes("\0"));
const schema=z.strictObject({schema_version:z.literal(1),origin:z.string().max(2048).refine(value=>{try{const u=new URL(value);return u.protocol==="https:"&&u.origin===value&&!u.username&&!u.password;}catch{return false;}}),
  port:z.number().int().min(1024).max(65535),control_socket:absolute.refine(value=>Buffer.byteLength(value)<=100),dispatcher_database:absolute,dispatcher_socket:absolute.refine(value=>Buffer.byteLength(value)<=100),active_release_pointer:absolute.optional(),runtime_socket:absolute.refine(value=>Buffer.byteLength(value)<=100)});
export type DashboardConfig=z.infer<typeof schema>;
export function parseDashboardConfig(input:unknown):DashboardConfig {try{return schema.parse(input);}catch{throw Error("dashboard_config_invalid");}}
export function readDashboardConfig(file:string):DashboardConfig {
  try {
    if(!path.isAbsolute(file)||fs.realpathSync(file)!==file)throw Error();
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try {const info=fs.fstatSync(fd);if(!info.isFile()||info.uid!==process.getuid?.()||(info.mode&0o777)!==0o600||info.nlink!==1||info.size>8192)throw Error();
      return parseDashboardConfig(JSON.parse(fs.readFileSync(fd,"utf8")));
    }finally{fs.closeSync(fd);}
  }catch{throw Error("dashboard_config_unverified");}
}
