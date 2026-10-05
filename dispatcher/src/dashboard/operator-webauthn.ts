import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions,
  verifyAuthenticationResponse, type RegistrationResponseJSON, type AuthenticationResponseJSON,
  type WebAuthnCredential } from "@simplewebauthn/server";
import { OperatorAuthError, type OperatorAuthRegistry, type OperatorAuthority, type OperatorSession } from "./operator-auth.js";
import { stableStringify } from "../validation.js";

export interface ApprovalIntent {
  request_id:string; decision:"approve"|"reject"; presentation_digest:string; expires_at:string;
}
export interface OperatorStepUp extends OperatorAuthority, ApprovalIntent { receipt_id:string }
type ApprovalCapability="approvals:native"|"approvals:external";
interface Ceremony {id:string;token:string;device:string;revision:number;challenge:string;deadline:number;
  kind:"register"|"approve";intent?:ApprovalIntent;capability?:ApprovalCapability}
interface CredentialRow {device_id:string;credential_id:string;public_key:Buffer;counter:number;origin:string}
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");

/** WebAuthn proofs stay inside the Dispatcher. A browser can only return a
 * signed ceremony response; it cannot supply a trusted step-up receipt. */
export class OperatorWebAuthn {
  private readonly ceremonies=new Map<string,Ceremony>();
  private readonly receipts=new Map<string,{value:OperatorStepUp;token:string;capability:ApprovalCapability;deadline:number}>();
  private readonly rpID:string;
  constructor(private readonly sql:Database.Database,private readonly auth:OperatorAuthRegistry,
    private readonly origin:string,private readonly monotonic=()=>performance.now(),private readonly wall=()=>Date.now()) {
    const url=new URL(origin);
    if(url.protocol!=="https:"||url.origin!==origin)throw new OperatorAuthError("invalid");
    this.rpID=url.hostname;
    sql.exec(`CREATE TABLE IF NOT EXISTS dashboard_operator_credentials (
      device_id TEXT PRIMARY KEY REFERENCES dashboard_operator_devices(device_id),credential_id TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL,counter INTEGER NOT NULL CHECK(counter>=0),origin TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS dashboard_operator_stepup_receipts (
      receipt_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      proof_json TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;`);
  }
  status(token:string):{registered:boolean;can_enroll:boolean} {
    const session=this.session(token);
    return {registered:!!this.credential(session.device_id),can_enroll:this.auth.canEnroll(token)};
  }
  async registrationOptions(token:string) {
    const session=this.session(token);
    if(!this.auth.canEnroll(token)||this.credential(session.device_id))throw new OperatorAuthError("denied");
    const options=await generateRegistrationOptions({rpName:"Dona",rpID:this.rpID,userName:session.device_id,
      userID:new TextEncoder().encode(session.device_id),attestationType:"none",
      authenticatorSelection:{residentKey:"preferred",userVerification:"required"}});
    this.sameSession(token,session);
    const ceremony=this.save(token,session,options.challenge,"register");
    return {ceremony_id:ceremony.id,options};
  }
  async register(token:string,id:string,response:RegistrationResponseJSON):Promise<{registered:true}> {
    const ceremony=this.load(token,id,"register");
    const proof=await verifyRegistrationResponse({response,expectedChallenge:value=>digest(value)===ceremony.challenge,
      expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true});
    if(!proof.verified||!proof.registrationInfo?.userVerified)throw new OperatorAuthError("denied");
    const credential=proof.registrationInfo.credential;
    this.sql.transaction(()=>{
      this.load(token,id,"register");
      if(!this.auth.canEnroll(token)||this.credential(ceremony.device))throw new OperatorAuthError("denied");
      this.sql.prepare("INSERT INTO dashboard_operator_credentials VALUES(?,?,?,?,?)")
        .run(ceremony.device,credential.id,Buffer.from(credential.publicKey),credential.counter,this.origin);
      this.ceremonies.delete(id);
    }).immediate();
    return {registered:true};
  }
  async approvalOptions(token:string,capability:ApprovalCapability,intent:ApprovalIntent) {
    const session=this.session(token,capability),credential=this.credential(session.device_id);
    if(!credential||!Number.isFinite(Date.parse(intent.expires_at))||Date.parse(intent.expires_at)<=this.wall()
      ||!intent.request_id||!intent.presentation_digest||!["approve","reject"].includes(intent.decision))throw new OperatorAuthError("denied");
    const options=await generateAuthenticationOptions({rpID:this.rpID,userVerification:"required",allowCredentials:[{id:credential.credential_id}]});
    this.sameSession(token,session);
    const ceremony=this.save(token,session,options.challenge,"approve",capability,intent);
    return {ceremony_id:ceremony.id,options};
  }
  async verify(token:string,id:string,response:AuthenticationResponseJSON):Promise<OperatorStepUp> {
    const ceremony=this.load(token,id,"approve"),credential=this.credential(ceremony.device);
    if(!credential||response.id!==credential.credential_id)throw new OperatorAuthError("denied");
    const publicCredential:WebAuthnCredential={id:credential.credential_id,publicKey:new Uint8Array(credential.public_key),counter:credential.counter};
    const proof=await verifyAuthenticationResponse({response,credential:publicCredential,
      expectedChallenge:value=>digest(value)===ceremony.challenge,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true});
    if(!proof.verified||!proof.authenticationInfo.userVerified)throw new OperatorAuthError("denied");
    return this.sql.transaction(()=>{
      this.load(token,id,"approve");
      const session=this.session(token,ceremony.capability!),current=this.credential(ceremony.device);
      if(!current||current.credential_id!==credential.credential_id||current.counter!==credential.counter)throw new OperatorAuthError("conflict");
      this.sql.prepare("UPDATE dashboard_operator_credentials SET counter=? WHERE device_id=? AND counter=?")
        .run(proof.authenticationInfo.newCounter,ceremony.device,current.counter);
      const expires_at=new Date(Math.min(Date.parse(ceremony.intent!.expires_at),this.wall()+Math.max(0,ceremony.deadline-this.monotonic()))).toISOString();
      const value:OperatorStepUp={receipt_id:randomUUID(),instance_id:session.instance_id,owner_id:session.owner_id,
        device_id:session.device_id,grant_revision:session.grant_revision,...ceremony.intent!,expires_at};
      // Retain the signed evidence for audit; restored SQL evidence alone never
      // recreates the process-bound authority held in receipts below.
      this.sql.prepare("INSERT INTO dashboard_operator_stepup_receipts VALUES(?,?,?,?,?)")
        .run(value.receipt_id,value.device_id,stableStringify(value),stableStringify(response),new Date(this.wall()).toISOString());
      this.receipts.set(value.receipt_id,{value,token,capability:ceremony.capability!,deadline:ceremony.deadline});
      this.ceremonies.delete(id);
      return value;
    }).immediate();
  }
  verifyReceipt(receipt:OperatorStepUp,expected:ApprovalIntent,capability:ApprovalCapability):boolean {
    this.prune();
    const stored=this.receipts.get(receipt.receipt_id);
    if(!Number.isFinite(Date.parse(expected.expires_at))||Date.parse(expected.expires_at)<=this.wall()
      ||!stored||stored.capability!==capability||stableStringify(stored.value)!==stableStringify(receipt)
      ||stored.value.request_id!==expected.request_id||stored.value.decision!==expected.decision
      ||stored.value.presentation_digest!==expected.presentation_digest||Date.parse(stored.value.expires_at)>Date.parse(expected.expires_at))return false;
    const session=this.auth.session(stored.token);
    return !!session&&session.device_id===receipt.device_id&&session.grant_revision===receipt.grant_revision
      &&session.capabilities.includes(capability)&&this.auth.authorize(receipt);
  }
  private credential(device:string):CredentialRow|undefined {
    const row=this.sql.prepare("SELECT * FROM dashboard_operator_credentials WHERE device_id=?").get(device) as CredentialRow|undefined;
    return row?.origin===this.origin?row:undefined;
  }
  private session(token:string,capability?:ApprovalCapability):OperatorSession {
    const value=this.auth.session(token);
    if(!value||(capability&&!value.capabilities.includes(capability)))throw new OperatorAuthError("denied");return value;
  }
  private sameSession(token:string,before:OperatorSession):void {
    const now=this.session(token);
    if(now.device_id!==before.device_id||now.grant_revision!==before.grant_revision)throw new OperatorAuthError("denied");
  }
  private save(token:string,session:OperatorSession,challenge:string,kind:Ceremony["kind"],capability?:ApprovalCapability,intent?:ApprovalIntent):Ceremony {
    this.prune();
    for(const [id,value] of this.ceremonies)if(value.device===session.device_id)this.ceremonies.delete(id);
    if(this.ceremonies.size>=32||this.receipts.size>=128)throw new OperatorAuthError("limit");
    const deadline=this.monotonic()+Math.min(120_000,intent?Date.parse(intent.expires_at)-this.wall():120_000);
    if(deadline<=this.monotonic())throw new OperatorAuthError("denied");
    const value:Ceremony={id:randomUUID(),token,device:session.device_id,revision:session.grant_revision,
      challenge:digest(challenge),deadline,kind,...(capability?{capability}:{}),...(intent?{intent:{...intent}}:{})};
    this.ceremonies.set(value.id,value);return value;
  }
  private load(token:string,id:string,kind:Ceremony["kind"]):Ceremony {
    this.prune();const value=this.ceremonies.get(id),session=this.session(token);
    if(!value||value.token!==token||value.kind!==kind||value.device!==session.device_id||value.revision!==session.grant_revision
      ||(value.capability&&!session.capabilities.includes(value.capability)))throw new OperatorAuthError("denied");return value;
  }
  private prune():void {
    for(const [id,value] of this.ceremonies)if(value.deadline<=this.monotonic()||!this.auth.session(value.token))this.ceremonies.delete(id);
    for(const [id,value] of this.receipts)if(value.deadline<=this.monotonic()||Date.parse(value.value.expires_at)<=this.wall()||!this.auth.session(value.token))this.receipts.delete(id);
  }
}
