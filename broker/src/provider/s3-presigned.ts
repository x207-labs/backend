// Presigned S3 URL adapter (BE-058, ADR-47): the URL is signed LOCALLY with AWS Signature V4 (query string form) by the grantor's own credentials; no call goes to AWS to grant, and
// S3 itself refuses the URL after `X-Amz-Expires`, so the access closes by itself (native expiry). The URL is the access: whoever holds it can read the object until it ends.
// Limit that is acknowledged: a presigned URL cannot be taken back before its end. `revoke` only forgets it; the end is the paid end, at most one day away (ADR-47: the loss of each
// side is at most one day). The secret key of the grantor never leaves this process; the URL carries the derived signature, not the key.
import { createHash, createHmac } from "node:crypto";
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";

/** S3 limit of a presigned URL signed with the key of a user. */
export const MAX_EXPIRES_SECONDS = 604_800;

export interface PresignOptions {
  /** Host name the URL points at (`<bucket>.s3.<region>.amazonaws.com`, or the host of a compatible store). */
  host: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256Hex = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer => createHmac("sha256", key).update(data, "utf8").digest();
/** RFC 3986 encoding of AWS: everything but `A-Za-z0-9-_.~` is percent-encoded; `/` too unless it is a path separator. */
const enc = (s: string, keepSlash = false): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%2F/g, keepSlash ? "/" : "%2F");
const amzDate = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

function signature(o: PresignOptions, method: string, path: string, query: Array<[string, string]>, date: string): string {
  const canonicalQuery = [...query].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
  const canonical = [method, path, canonicalQuery, `host:${o.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const day = date.slice(0, 8);
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), o.region), "s3"), "aws4_request");
  return createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
}

/** A presigned URL for `method` on `key` that is valid `expiresSeconds` from `nowMs`. */
export function presignUrl(o: PresignOptions, args: { key: string; nowMs: number; expiresSeconds: number; method?: "GET" | "PUT" }): string {
  const { key, nowMs, expiresSeconds } = args;
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > MAX_EXPIRES_SECONDS) throw new Error(`expiresSeconds harus 1 sampai ${MAX_EXPIRES_SECONDS}`);
  if (key.length === 0 || key.length > 1024 || key.startsWith("/") || /[\x00-\x1f]/.test(key)) throw new Error("key objek tidak sah");
  const date = amzDate(nowMs);
  const path = `/${enc(key, true)}`;
  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"], ["X-Amz-Credential", `${o.accessKeyId}/${date.slice(0, 8)}/${o.region}/s3/aws4_request`], ["X-Amz-Date", date],
    ["X-Amz-Expires", String(expiresSeconds)], ["X-Amz-SignedHeaders", "host"], ...(o.sessionToken ? ([["X-Amz-Security-Token", o.sessionToken]] as Array<[string, string]>) : []),
  ];
  const sig = signature(o, args.method ?? "GET", path, query, date);
  const q = [...query].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
  return `https://${o.host}${path}?${q}&X-Amz-Signature=${sig}`;
}

/** What S3 does with a presigned URL, for the tests: the signature must match the request and the time must be inside `X-Amz-Date` + `X-Amz-Expires`. */
export function s3AcceptsUrl(o: PresignOptions, url: string, nowMs: number, method = "GET"): { accepted: boolean; reason: string | null } {
  const u = new URL(url);
  const get = (name: string): string | null => u.searchParams.get(name);
  const date = get("X-Amz-Date");
  const expires = Number(get("X-Amz-Expires"));
  const given = get("X-Amz-Signature");
  if (u.host !== o.host || date === null || given === null || !Number.isInteger(expires)) return { accepted: false, reason: "malformed" };
  const query: Array<[string, string]> = [...u.searchParams.entries()].filter(([k]) => k !== "X-Amz-Signature");
  if (signature(o, method, u.pathname.replace(/%2F/g, "/"), query, date) !== given) return { accepted: false, reason: "SignatureDoesNotMatch" };
  const start = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)), Number(date.slice(9, 11)), Number(date.slice(11, 13)), Number(date.slice(13, 15)));
  if (nowMs >= start + expires * 1000) return { accepted: false, reason: "Request has expired" };
  if (nowMs < start - 15 * 60 * 1000) return { accepted: false, reason: "Request is not yet valid" };
  return { accepted: true, reason: null };
}

export interface S3PresignedOptions extends PresignOptions {
  now?: () => number;
}

export class S3PresignedAdapter implements ProviderAccessAdapter {
  readonly provider = "s3-presigned";
  readonly real = true;
  readonly nativeExpiry = true;
  readonly #o: S3PresignedOptions;
  readonly #now: () => number;
  /** handle -> end (unix ms); `revoke` only forgets, the URL lives on until its end. */
  readonly #ends = new Map<string, number>();

  constructor(options: S3PresignedOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    // nothing at the provider to look up: the URL is a bearer, the reference is a label of whom it was made for
    return /^[\x21-\x7e]{1,128}$/.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref harus ASCII tanpa spasi, 1 sampai 128 karakter" };
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    if (request.resource === null) throw new Error("grant presigned wajib menamai key objek di resource");
    const method = request.permission === "write" ? "PUT" : "GET";
    const now = this.#now();
    const seconds = Math.min(Math.floor((request.expiresAtMs - now) / 1000), MAX_EXPIRES_SECONDS);
    if (seconds < 1) throw new Error("masa berlaku habis sebelum URL bisa dibuat");
    const end = Math.floor(now / 1000) * 1000 + seconds * 1000;
    const url = presignUrl(this.#o, { key: request.resource, nowMs: now, expiresSeconds: seconds, method });
    const handle = `s3-${request.grantId}`;
    this.#ends.set(handle, end);
    return { handle, nativeExpiresAtMs: end, delivery: { url, method, expiresAt: new Date(end).toISOString() } };
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
