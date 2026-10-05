import { z } from "zod";
import type { DispatcherDatabase } from "../database.js";
import { OperatorAuthError } from "./operator-auth.js";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { operatorCommand, operatorQuestions, type OperatorCommandPaths } from "./operator-commands.js";
import type { QuestionRecord } from "../app-server/store.js";
import { operatorNativeRequest } from "./operator-native.js";
import type { LocalExternalApprovalService } from "../approval/local-external-service.js";
import { operatorExternalRequest } from "./operator-external.js";

export interface OperatorApiContext extends OperatorCommandPaths {
  readQuestions(agent:string):Promise<QuestionRecord[]>;
  wake():void;
  external?:LocalExternalApprovalService;
}

const tokenSchema = z.strictObject({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
/** Only Dispatcher private UDS calls this router. Admin routes are never
 * forwarded from the browser-facing HTTP server. */
export async function operatorRequest(database:DispatcherDatabase, route:string, input:unknown,context?:OperatorApiContext):Promise<unknown> {
  const auth=database.operatorAuth;
  if(route.startsWith('external/')) {
    if(!context)throw new OperatorAuthError('denied');
    return operatorExternalRequest(database,context,route.slice('external/'.length),input);
  }
  if(route.startsWith('native/')) {
    if(!context)throw new OperatorAuthError('denied');
    return operatorNativeRequest(database,context,route.slice('native/'.length),input);
  }
  if(route.startsWith('commands/')) {
    if(!context)throw new OperatorAuthError('denied');
    const body=z.strictObject({token:z.string().max(128),input:z.unknown()}).parse(input);
    const result=operatorCommand(database,context,{...body,operation:route.slice('commands/'.length)});
    if(route!=='commands/receipt')context.wake();
    return result;
  }
  if(route==='questions') {
    if(!context)throw new OperatorAuthError('denied');
    return operatorQuestions(database,input,agent=>context.readQuestions(agent));
  }
  switch(route) {
    case "admin/reset": database.configureOperatorOrigin(z.strictObject({origin:z.string().max(2048)}).parse(input).origin); return {ok:true};
    case "admin/status": z.strictObject({}).parse(input); return auth.status();
    case "admin/pair": return auth.issueCode(z.strictObject({capabilities:z.unknown()}).parse(input).capabilities);
    case "admin/revoke": {
      const value=z.strictObject({device_id:z.string().optional()}).parse(input);auth.revoke(value.device_id);return {ok:true};
    }
    case "pair": return auth.pair(z.strictObject({code:z.string().max(128)}).parse(input).code);
    case "session": {
      const value=auth.session(tokenSchema.parse(input).token);
      if(!value)throw new OperatorAuthError("denied");return value;
    }
    case "logout": auth.logout(tokenSchema.parse(input).token);return {ok:true};
    case "credential/status": {
      if(!database.operatorWebAuthn)throw new OperatorAuthError("denied");
      return database.operatorWebAuthn.status(tokenSchema.parse(input).token);
    }
    case "credential/options": {
      if(!database.operatorWebAuthn)throw new OperatorAuthError("denied");
      return database.operatorWebAuthn.registrationOptions(tokenSchema.parse(input).token);
    }
    case "credential/register": {
      if(!database.operatorWebAuthn)throw new OperatorAuthError("denied");
      const body=z.strictObject({token:z.string().max(128),ceremony_id:z.string().uuid(),response:z.record(z.string(),z.unknown())}).parse(input);
      return database.operatorWebAuthn.register(body.token,body.ceremony_id,body.response as unknown as RegistrationResponseJSON);
    }
    default: throw new OperatorAuthError("invalid");
  }
}
