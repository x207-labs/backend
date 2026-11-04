import { x207Middleware, X207ExtraSource } from "@x207/scheme";
import type { AccessGrant } from "@x207/core";
import type { AuditLog } from "../audit.js";
import type { BrokerChain } from "../chain.js";
import { guardVoucher } from "../in-flight.js";
import { DispatchError, type Dispatcher } from "../dispatcher.js";
import type { BrokerStore } from "../store.js";
import { DEFAULT_ACCESS_LIMITS, WindowCounter, type AccessLimits } from "../provider/limits.js";
import type { ClassCAdapter } from "./class-c.js";
import { inScope, parseProxyScope, SecretNotConfiguredError, type ProviderRegistry } from "./providers.js";

export interface ProxyOptions {
  dispatcher: Dispatcher;
  classC: ClassCAdapter;
  providers: ProviderRegistry;
  chain: BrokerChain;
  store: BrokerStore;
  facilitatorUrl: string;
  circleId: string;
  brokerAccount: string;
  extra: X207ExtraSource;
  creditPrice: (baseUnits: string) => string;
  fetch?: typeof fetch;
  /** Audit log of the calls and refusals (BK-011). */
  audit?: AuditLog;
  /** Timeout of the call to the provider. */
  timeoutMs?: number;
  /** B7-P1: the account whose secrets the broker holds; a real (not `mock`) provider is served only for a grant of this grantor. Default `brokerAccount`. */
  owner?: string;
  /** B7-P6: largest body of a proxied call and largest answer of the provider, in bytes (defaults 4 MiB and 8 MiB). */
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  /** B7-P6: requests per minute per address and per grant on the proxy and usage routes (defaults of the access routes). */
  limits?: Partial<Pick<AccessLimits, "ipPerMinute" | "grantPerMinute">>;
  /** `hosted` serves only providers marked `mock` (BE-070, ADR-48); default `self-hosted`. */
  mode?: "self-hosted" | "hosted";
}

export const USAGE_PATH = /^\/grants\/(0|[1-9]\d*)\/usage$/;
const PROXY_PATH = /^\/grants\/(0|[1-9]\d*)\/proxy(\/.*)?$/;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Hop-by-hop and payment headers do not go to the provider; the secret header is set by the broker only. */
const STRIP = new Set([
  "host", "connection", "content-length", "payment-signature", "authorization", "cookie", "transfer-encoding", "proxy-authorization", "forwarded", "via", "x-real-ip",
  // headers that make a provider change the method or the route of the call after the scope was checked (security review 2)
  "x-http-method-override", "x-method-override", "x-http-method", "x-original-url", "x-rewrite-url",
]);
const stripped = (name: string): boolean => STRIP.has(name) || name.startsWith("x-forwarded-");

/** `GET /grants/{id}/usage` (BE-070): the calls that were billed, per epoch, and what they cost. A buyer compares it with the count it keeps. */
export function createUsageHandler(options: Pick<ProxyOptions, "dispatcher" | "classC" | "store" | "limits">): (request: Request) => Promise<Response> {
  const limits = { ...DEFAULT_ACCESS_LIMITS, ...options.limits };
  const ipHits = new WindowCounter();
  const grantHits = new WindowCounter();
  return async (request) => {
    const m = USAGE_PATH.exec(new URL(request.url).pathname);
    if (m === null || request.method !== "GET") return json(404, { error: "not_found" });
    const grantId = Number(m[1]);
    // B7-P6: the route answers anyone, so it has the same window counters as the proxy
    const limited = tooMany(request, grantId, limits, ipHits, grantHits);
    if (limited) return limited;
    let grant: AccessGrant;
    try {
      grant = await options.dispatcher.open(grantId);
    } catch (error) {
      if (error instanceof DispatchError) return json(error.status, { error: error.code, message: error.message });
      return json(502, { error: "chain_unavailable", message: (error as Error).message });
    }
    if (grant.class !== "C") return json(501, { error: "class_not_supported" });
    const perEpoch = options.store.callsByEpoch(grantId);
    const calls = perEpoch.reduce((n, e) => n + e.calls, 0);
    const charge = options.classC.meter(grant, { quantity: 1 });
    return json(200, { grantId, unit: "call", unitPrice: charge.amount, calls, billed: (BigInt(charge.amount) * BigInt(calls)).toString(), epochs: perEpoch, decimals: 6 });
  };
}

/** `true` when this request is for the class C proxy; the answer is in `handle`. */
export function matchProxy(url: URL): { grantId: number; path: string } | null {
  const m = PROXY_PATH.exec(url.pathname);
  return m === null ? null : { grantId: Number(m[1]), path: m[2] ?? "/" };
}

/**
 * BK-008: `POST /grants/{grantId}/proxy/*`. Order: the grant (active, class C), the scope (`403 grant_scope_denied`), the quota of the epoch
 * (`429 grant_quota_exceeded`), then `@x207/scheme` answers 402, verifies the voucher, forwards the call with the secret of the grantor, and
 * settles only when the provider answered with success. A refused or failed call leaves no voucher pending and does not use quota.
 */
export function createProxyHandler(options: ProxyOptions): (request: Request, target: { grantId: number; path: string }) => Promise<Response> {
  const maxBody = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const maxResponse = options.maxResponseBytes ?? 8 * 1024 * 1024;
  const limits = { ...DEFAULT_ACCESS_LIMITS, ...options.limits };
  const ipHits = new WindowCounter();
  const grantHits = new WindowCounter();
  return async (request, { grantId, path }) => {
    // B7-P6: an address and a grant get a number of requests per minute, before the chain is asked anything
    const limited = tooMany(request, grantId, limits, ipHits, grantHits);
    if (limited) return limited;
    // B7-P6: a body larger than the cap is refused on its declared length, before the grant is even read; the body itself is read only after the payment passed
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBody) return json(413, { error: "payload_too_large", message: `body is larger than ${maxBody} bytes` });
    let grant: AccessGrant;
    try {
      grant = await options.dispatcher.open(grantId);
      options.dispatcher.adapterFor(grant);
    } catch (error) {
      if (error instanceof DispatchError) return json(error.status, { error: error.code, message: error.message });
      return json(502, { error: "chain_unavailable", message: (error as Error).message });
    }
    if (grant.class !== "C") return json(501, { error: "class_not_supported" });

    const provider = options.providers.get(grant.asset_type);
    if (provider === undefined) return json(501, { error: "class_not_supported", message: `no provider for ${grant.asset_type}` });
    // a real secret is served only by the broker of its owner: the hosted broker is for the demo with a mock provider
    if ((options.mode ?? "self-hosted") === "hosted" && provider.mock !== true) {
      options.audit?.record({ kind: "proxy_refused", grantId, assetType: grant.asset_type, method: request.method, path, status: 501, code: "secret_hosted_forbidden" });
      return json(501, { error: "secret_hosted_forbidden", message: "a hosted broker serves mock providers only; a real key stays on the broker that its owner runs" });
    }
    // B7-P1: the secret belongs to the owner of this broker. A grant of another member names another grantor, and the broker would serve it with the key of the owner and pay the other member
    if (provider.mock !== true && grant.grantor !== (options.owner ?? options.brokerAccount)) {
      options.audit?.record({ kind: "proxy_refused", grantId, assetType: grant.asset_type, method: request.method, path, status: 403, code: "grant_not_owned" });
      return json(403, { error: "grant_not_owned", message: `the secret for ${grant.asset_type} belongs to ${options.owner ?? options.brokerAccount}, and this grant is from ${grant.grantor}` });
    }
    let scope;
    try {
      scope = parseProxyScope(grant.limits.scope);
    } catch (error) {
      return json(403, { error: "grant_scope_denied", message: (error as Error).message });
    }
    if (!inScope(scope, request.method, path)) {
      options.audit?.record({ kind: "proxy_refused", grantId, assetType: grant.asset_type, method: request.method, path, status: 403, code: "grant_scope_denied" });
      return json(403, { error: "grant_scope_denied", message: `${request.method} ${path} is outside the scope` });
    }

    let epoch: number;
    try {
      epoch = await options.chain.currentEpoch();
    } catch (error) {
      return json(502, { error: "chain_unavailable", message: (error as Error).message });
    }
    const quota = grant.limits.quota === null || grant.limits.quota === undefined ? undefined : BigInt(grant.limits.quota);
    if (quota !== undefined && BigInt(options.store.calls(grantId, epoch)) >= quota) {
      options.audit?.record({ kind: "proxy_refused", grantId, assetType: grant.asset_type, method: request.method, path, status: 429, code: "grant_quota_exceeded" });
      return json(429, { error: "grant_quota_exceeded", message: `quota of ${quota} calls in epoch ${epoch} is used` });
    }

    const charge = options.classC.meter(grant, { quantity: 1 });
    const url = new URL(request.url);
    const middleware = x207Middleware({
      routes: { [url.pathname]: { price: options.creditPrice(charge.amount), description: `Call through grant ${grantId}`, grant: () => ({ grantId, payTo: grant.grantor }) } },
      facilitatorUrl: options.facilitatorUrl, circleId: options.circleId, payTo: options.brokerAccount, extra: options.extra,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    // the body is read from a clone only inside the paid callback, so an unpaid call costs no memory
    const unread = request.method === "GET" || request.method === "HEAD" ? undefined : request.clone();
    let counted = false;
    const answer = await guardVoucher(request, () => middleware(request, async (paid) => {
      const payer = payerOf(paid.headers.get("PAYMENT-SIGNATURE"));
      if (payer !== grant.grantee) options.audit?.record({ kind: "proxy_refused", grantId, assetType: grant.asset_type, method: request.method, path, status: 403, code: "payer_not_grantee" });
      if (payer !== grant.grantee) return json(403, { error: "payer_not_grantee", message: `grant ${grantId} is leased to ${grant.grantee}` });
      let auth: [string, string];
      try {
        auth = options.providers.authHeader(provider);
      } catch (error) {
        if (error instanceof SecretNotConfiguredError) return json(502, { error: "secret_not_configured", message: (error as Error).message });
        return json(502, { error: "delivery_failed", message: (error as Error).message });
      }
      let body: ArrayBuffer | undefined;
      if (unread !== undefined) {
        const bytes = await readCappedBytes(unread, maxBody);
        if (bytes === null) return json(413, { error: "payload_too_large", message: `body is larger than ${maxBody} bytes` });
        body = bytes;
      }
      const headers = new Headers();
      for (const [name, value] of paid.headers) if (!stripped(name.toLowerCase())) headers.set(name, value);
      headers.set(auth[0], auth[1]);
      // The slot is taken before the call and given back when the call fails, so parallel requests cannot go past the quota (security review 2).
      if (quota !== undefined && !options.store.reserveCall(grantId, epoch, quota)) {
        options.audit?.record({ kind: "proxy_refused", grantId, assetType: grant.asset_type, method: request.method, path, status: 429, code: "grant_quota_exceeded" });
        return json(429, { error: "grant_quota_exceeded", message: `quota of ${quota} calls in epoch ${epoch} is used` });
      }
      const release = () => {
        if (quota !== undefined) options.store.releaseCall(grantId, epoch);
      };
      let upstream: Response;
      let text: ArrayBuffer;
      try {
        // redirect "manual": a redirect of the provider must not carry the secret to another host
        upstream = await (options.fetch ?? fetch)(`${provider.baseUrl.replace(/\/+$/, "")}${path}${url.search}`, {
          method: request.method, headers, redirect: "manual", ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        });
        const raw = await readCappedBytes(upstream, maxResponse);
        if (raw === null) {
          release();
          return json(502, { error: "provider_response_too_large", message: `the provider answered more than ${maxResponse} bytes; the call is not billed` });
        }
        text = options.providers.redact(provider, raw);
      } catch (error) {
        release();
        return json(502, { error: "provider_unreachable", message: (error as Error).name });
      }
      options.audit?.record({
        kind: "proxy_call", grantId, assetType: grant.asset_type, method: request.method, path, status: upstream.status,
        secretVersion: options.providers.version(grant.asset_type),
      });
      // a provider that failed is passed on as it is; the middleware does not settle a status of 400 or more
      // a redirect is not passed on (it could lead to another host) and is not billed: the middleware settles any status below 400, so it is turned into a 502 here
      if (upstream.status >= 300 && upstream.status < 400) {
        release();
        return json(502, { error: "provider_redirect", message: `the provider answered ${upstream.status}; redirects are not followed and not billed` });
      }
      if (upstream.status >= 400) {
        release();
        return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" } });
      }
      // B7-P3: 204, 205 and the answer to a HEAD have no body, and the Response constructor throws on a body for them
      const bodyless = upstream.status === 204 || upstream.status === 205 || request.method === "HEAD";
      let out: Response;
      try {
        out = new Response(bodyless ? null : text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" } });
      } catch (error) {
        release();
        return json(502, { error: "provider_response_invalid", message: (error as Error).message });
      }
      // the call is counted only now, when the answer exists
      if (quota === undefined) options.store.countCall(grantId, epoch);
      counted = true;
      return out;
    }));
    // B7-P4: the call was made and counted, but the payment did not go through (settle failed, the 402 replaced our answer): nothing was billed, so it is not counted either, and the audit says so
    if (counted && answer.status >= 400) {
      options.store.releaseCall(grantId, epoch);
      options.audit?.record({ kind: "unbilled_call", grantId, assetType: grant.asset_type, method: request.method, path, status: answer.status, secretVersion: options.providers.version(grant.asset_type) });
    }
    return answer;
  };
}

/** The bytes of a body, or `null` when it is larger than `max` (checked on the declared length and again while it is read). */
async function readCappedBytes(source: Request | Response, max: number): Promise<ArrayBuffer | null> {
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const reader = source.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = Buffer.concat(chunks);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

/** `429 rate_limited` when the address of the peer or the grant is over its requests per minute; `undefined` otherwise. */
function tooMany(request: Request, grantId: number, limits: AccessLimits, ipHits: WindowCounter, grantHits: WindowCounter): Response | undefined {
  const t = Date.now();
  const waitIp = ipHits.hit(request.headers.get("x-x207-peer") ?? "unknown", limits.ipPerMinute, t);
  const waitGrant = grantHits.hit(`grant:${grantId}`, limits.grantPerMinute, t);
  const wait = Math.max(waitIp, waitGrant);
  if (wait === 0) return undefined;
  return new Response(JSON.stringify({ error: "rate_limited", message: `too many requests (${waitIp > 0 ? "address" : "grant"})` }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(wait) } });
}

function payerOf(header: string | null): string | undefined {
  if (header === null) return undefined;
  try {
    return (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload?: { voucher?: { payer?: string } } }).payload?.voucher?.payer;
  } catch {
    return undefined;
  }
}
