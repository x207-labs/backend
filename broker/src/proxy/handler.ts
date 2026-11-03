import { x207Middleware, X207ExtraSource } from "@x207/scheme";
import type { AccessGrant } from "@x207/core";
import type { AuditLog } from "../audit.js";
import type { BrokerChain } from "../chain.js";
import { guardVoucher } from "../in-flight.js";
import { DispatchError, type Dispatcher } from "../dispatcher.js";
import type { BrokerStore } from "../store.js";
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
export function createUsageHandler(options: Pick<ProxyOptions, "dispatcher" | "classC" | "store">): (request: Request) => Promise<Response> {
  return async (request) => {
    const m = USAGE_PATH.exec(new URL(request.url).pathname);
    if (m === null || request.method !== "GET") return json(404, { error: "not_found" });
    const grantId = Number(m[1]);
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
  return async (request, { grantId, path }) => {
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
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.clone().arrayBuffer();
    return guardVoucher(request, () => middleware(request, async (paid) => {
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
        text = options.providers.redact(provider, await upstream.arrayBuffer());
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
      if (quota === undefined) options.store.countCall(grantId, epoch);
      return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" } });
    }));
  };
}

function payerOf(header: string | null): string | undefined {
  if (header === null) return undefined;
  try {
    return (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload?: { voucher?: { payer?: string } } }).payload?.voucher?.payer;
  } catch {
    return undefined;
  }
}
