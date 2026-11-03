// AWS STS adapter (BE-059, ADR-47 group B): a session of a role of the grantor, with a PERMISSION BOUNDARY. The grantor makes a role whose boundary caps what any session can do; this
// adapter refuses to give a session of a role that does not carry the boundary it is configured with (`iam:GetRole` is read first), and adds a session policy that narrows the session
// again to the resource of the grant. The session ends by itself (`DurationSeconds`): native expiry. The credentials of the session go to the lessee; the long-term key of the grantor
// that signs the requests stays on the broker's machine. STS has a floor of 900 seconds, so a session cannot be made for less.
// Limit: a session cannot be taken back before it ends; `revoke` forgets it. The loss is at most the paid day (and the permission boundary caps what it can do).
import { createHash, createHmac } from "node:crypto";
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, type FetchLike } from "./http.js";

export const STS_MIN_SECONDS = 900;
const ARN_ROLE = /^arn:aws:iam::\d{12}:role\/[\w+=,.@/-]{1,128}$/;
const SESSION_NAME = /^[\w+=,.@-]{2,64}$/;

export interface AwsStsOptions {
  accessKeyId: string;
  secretAccessKey: string;
  /** ARN of the policy that every assumable role must carry as its permissions boundary. */
  permissionsBoundaryArn: string;
  /** Roles the broker may assume. */
  allowedRoleArns: readonly string[];
  region?: string;
  /** Longest session (seconds); the role itself has a maximum too. Default 12 hours. */
  maxSeconds?: number;
  stsUrl?: string;
  iamUrl?: string;
  now?: () => number;
  fetch?: FetchLike;
}

const hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (k: Buffer | string, d: string): Buffer => createHmac("sha256", k).update(d, "utf8").digest();
const form = (p: Record<string, string>): string => Object.entries(p).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

/** AWS Signature V4 headers for a POST of a query API (`sts`, `iam`). */
export function signPost(args: { accessKeyId: string; secretAccessKey: string; region: string; service: string; host: string; body: string; nowMs: number }): Record<string, string> {
  const date = new Date(Math.floor(args.nowMs / 1000) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const day = date.slice(0, 8);
  const type = "application/x-www-form-urlencoded; charset=utf-8";
  const canonical = ["POST", "/", "", `content-type:${type}`, `host:${args.host}`, `x-amz-date:${date}`, "", "content-type;host;x-amz-date", hex(args.body)].join("\n");
  const scope = `${day}/${args.region}/${args.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${args.secretAccessKey}`, day), args.region), args.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return { "content-type": type, "x-amz-date": date, authorization: `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope}, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}` };
}

const tag = (xml: string, name: string): string | null => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? null;

export class AwsStsAdapter implements ProviderAccessAdapter {
  readonly provider = "aws-sts";
  readonly real = true;
  readonly nativeExpiry = true;
  readonly #o: AwsStsOptions;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #region: string;
  readonly #ends = new Map<string, number>();

  constructor(options: AwsStsOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
    this.#region = options.region ?? "us-east-1";
  }

  async #query(service: "sts" | "iam", url: string, params: Record<string, string>): Promise<string> {
    const host = new URL(url).host;
    const body = form(params);
    const headers = signPost({ accessKeyId: this.#o.accessKeyId, secretAccessKey: this.#o.secretAccessKey, region: this.#region, service, host, body, nowMs: this.#now() });
    return (await call(this.#fetch, url, headers, { method: "POST", path: "/", body }, [200])).text;
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    // the lessee has no account at AWS: the session is made for a name, which becomes the RoleSessionName in the logs of the grantor
    return SESSION_NAME.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref must be 2 to 64 characters [A-Za-z0-9_+=,.@-]" };
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const role = request.resource;
    if (role === null || !ARN_ROLE.test(role)) throw new Error("resource must be an IAM role ARN");
    if (!this.#o.allowedRoleArns.includes(role)) throw new Error("role is not in this broker's allowedRoleArns");
    const now = this.#now();
    const seconds = Math.min(Math.floor((request.expiresAtMs - now) / 1000), this.#o.maxSeconds ?? 43_200);
    if (seconds < STS_MIN_SECONDS) throw new Error(`remaining lease time of ${seconds} seconds is below the STS minimum (${STS_MIN_SECONDS})`);
    // the boundary is read from the role itself on every grant, not remembered
    const got = await this.#query("iam", this.#o.iamUrl ?? "https://iam.amazonaws.com/", { Action: "GetRole", Version: "2010-05-08", RoleName: role.slice(role.lastIndexOf("/") + 1) });
    if (!got.includes(`<PermissionsBoundaryArn>${this.#o.permissionsBoundaryArn}</PermissionsBoundaryArn>`)) throw new Error("role does not carry the required permission boundary");
    const policy = JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: request.permission === null ? ["s3:GetObject"] : [request.permission], Resource: "*" }] });
    const xml = await this.#query("sts", this.#o.stsUrl ?? "https://sts.amazonaws.com/", {
      Action: "AssumeRole", Version: "2011-06-15", RoleArn: role, RoleSessionName: request.granteeRef, DurationSeconds: String(seconds), Policy: policy,
    });
    const credentials = { accessKeyId: tag(xml, "AccessKeyId"), secretAccessKey: tag(xml, "SecretAccessKey"), sessionToken: tag(xml, "SessionToken"), expiration: tag(xml, "Expiration") };
    if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken || !credentials.expiration) throw new Error("STS response does not contain session credentials");
    const end = Date.parse(credentials.expiration);
    if (!Number.isFinite(end)) throw new Error("STS Expiration is invalid");
    const handle = `sts:${request.grantId}:${credentials.accessKeyId}`;
    this.#ends.set(handle, end);
    return { handle, nativeExpiresAtMs: end, delivery: { provider: "aws-sts", roleArn: role, credentials, expiresAt: credentials.expiration } };
  }

  async revoke(handle: string): Promise<void> {
    this.#ends.delete(handle);
  }

  async status(handle: string): Promise<AccessState> {
    const end = this.#ends.get(handle);
    if (end === undefined) return "absent";
    return this.#now() >= end ? "expired" : "active";
  }
}
