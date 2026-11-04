// HTTP routes of the rent of a P2 access (BE-060, ADR-47), on the same server as the lease of class B:
//   POST /grants/{grantId}/access        pays one day (x402, like the lease) and asks for the access: body {grantee_ref, proof?}
//   GET  /grants/{grantId}/access        status, the bill of today, and the state of a revoke that is pending
//   GET  /grants/{grantId}/access/challenge   the challenge to sign for the proof of the reference (BE-057): `{required, challenge, nonce, expiresAt, circle, granteeRef}`
//   POST /grants/{grantId}/access/stop   the lessee ends the rent: body {notice, signature}, signed with its voucher key
// Everything goes through `ProviderAccessManager`: the same checks (`verifyGranteeRef`, native expiry), the same retry of a revoke. Errors are `{error, message}`; the codes are in the README.
import { createHash } from "node:crypto";
import { meterGrant, nep413SigningHash, verifyHash } from "@x207/core";
import { x207Middleware, X207ExtraSource } from "@x207/scheme";
import type { AccessGrant } from "@x207/core";
import { DispatchError, type Dispatcher } from "../dispatcher.js";
import { guardVoucher } from "../in-flight.js";
import { ProviderAccessError, parseProviderScope, type ProviderAccessErrorCode } from "./adapter.js";
import { DEFAULT_ACCESS_LIMITS, readCapped, WindowCounter, type AccessLimits } from "./limits.js";
import type { ProviderAccessManager } from "./manager.js";

export const ACCESS_PATH = /^\/grants\/(0|[1-9]\d*)\/access(\/stop|\/challenge)?$/;
const SKEW_SECONDS = 600;

export interface ProviderRoutesOptions {
  manager: ProviderAccessManager;
  dispatcher: Dispatcher;
  facilitatorUrl: string;
  circleId: string;
  /** Account of the circle contract (the `circle` of signed notices). */
  contractId: string;
  brokerAccount: string;
  extra: X207ExtraSource;
  creditPrice: (baseUnits: string) => string;
  /** Voucher key of an account, from the read API; `null` when the account is unknown. */
  voucherKeyOf: (account: string) => Promise<string | null>;
  now?: () => number;
  fetch?: typeof fetch;
  /** BE-066: rate per peer address and per grant, and the largest body. */
  limits?: Partial<AccessLimits>;
}

export const ERROR_STATUS: Record<ProviderAccessErrorCode, number> = {
  scope_invalid: 400, grantee_ref_unverified: 403, access_not_found: 404, cap_exceeded: 409, provider_unknown: 501, hosted_mode_real_provider: 501, native_expiry_required: 502, access_conflict: 409, provider_grant_failed: 502, vote_kind_forbidden: 403, dao_unknown: 403, delegation_not_scoped: 403,
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (error: unknown): Response => {
  if (error instanceof ProviderAccessError) return json(ERROR_STATUS[error.code], { error: error.code, message: error.message });
  if (error instanceof DispatchError) return json(error.status, { error: error.code, message: error.message });
  return json(502, { error: "provider_unavailable", message: (error as Error).message });
};
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** The notice of `stop`: canonical JSON with the keys `circle, grant_id, actor, action, at`; `action` is `stop`. */
export const stopNoticeText = (n: { circle: string; grant_id: number; actor: string; at: number }): string => JSON.stringify({ circle: n.circle, grant_id: n.grant_id, actor: n.actor, action: "stop", at: n.at });

export function createProviderRoutes(options: ProviderRoutesOptions): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  const { manager } = options;

  async function view(grant: AccessGrant) {
    const a = manager.access(grant.grant_id);
    if (!a) return null;
    const cost = await manager.costSoFar(grant.grant_id).catch(() => null);
    const day = Math.floor(now() / 86_400_000);
    return {
      grantId: grant.grant_id, provider: a.provider, granteeRef: a.granteeRef, status: a.status, paidUntil: iso(a.paidUntilMs), providerExpiresAt: iso(a.nativeExpiresMs), reason: a.reason,
      proof: a.proof, warnings: a.proof === "verified" ? [] : ["grantee_unproven"], revokePending: a.status === "revoke_pending" ? { attempts: a.attempts, nextRetryAt: iso(a.nextRetryMs), lastError: a.lastError } : null,
      today: { day, cost: cost === null ? null : cost.toString(), billed: manager.charges(grant.grant_id).find((c) => c.day === day)?.amount.toString() ?? null },
      unit: "credit", decimals: 6,
    };
  }

  const limits: AccessLimits = { ...DEFAULT_ACCESS_LIMITS, ...options.limits };
  const ipHits = new WindowCounter();
  const grantHits = new WindowCounter();
  const tooMany = (wait: number, scope: string): Response =>
    new Response(JSON.stringify({ error: "rate_limited", message: `too many requests (${scope})` }), { status: 429, headers: { "content-type": "application/json", "retry-after": String(wait) } });

  return async (request) => {
    const url = new URL(request.url);
    const match = ACCESS_PATH.exec(url.pathname);
    if (match === null) return json(404, { error: "not_found" });
    const grantId = Number(match[1]);
    // the peer address is put in the request by `serve` (a header of the caller with that name is overwritten there)
    const t = now();
    const waitIp = ipHits.hit(request.headers.get("x-x207-peer") ?? "unknown", limits.ipPerMinute, t);
    if (waitIp > 0) return tooMany(waitIp, "address");
    const waitGrant = grantHits.hit(`grant:${grantId}`, limits.grantPerMinute, t);
    if (waitGrant > 0) return tooMany(waitGrant, "grant");
    if (request.method === "POST") {
      const declared = Number(request.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limits.maxBodyBytes) return json(413, { error: "payload_too_large", message: `body is larger than ${limits.maxBodyBytes} bytes` });
    }
    const stop = match[2] === "/stop";
    const challengePath = match[2] === "/challenge";

    if (request.method === "GET" && challengePath) {
      try {
        const grant = await options.dispatcher.open(grantId);
        parseProviderScope(grant.limits.scope);
        const c = manager.issueChallenge(grant);
        if (c === null) return json(200, { required: false });
        return json(200, { required: true, grantId, circle: c.circle, granteeRef: c.granteeRef, nonce: c.nonce, challenge: c.text, expiresAt: iso(c.expiresAtMs) });
      } catch (error) {
        return fail(error);
      }
    }

    if (request.method === "GET" && !stop) {
      try {
        const grant = await options.dispatcher.open(grantId).catch(async (e) => {
          // a revoked grant still has an access to look at
          if (e instanceof DispatchError && e.code === "grant_revoked") return null;
          throw e;
        });
        const a = manager.access(grantId);
        if (!a) return json(404, { error: "access_not_found", message: `grant ${grantId} has no access` });
        return json(200, await view(grant ?? ({ grant_id: grantId } as AccessGrant)));
      } catch (error) {
        return fail(error);
      }
    }

    if (request.method === "POST" && stop) {
      let grant: AccessGrant;
      try {
        grant = await options.dispatcher.open(grantId);
      } catch (error) {
        if (error instanceof DispatchError && error.code === "grant_revoked" && manager.access(grantId)) return json(200, await view({ grant_id: grantId } as AccessGrant));
        return fail(error);
      }
      let body: { notice?: { circle?: unknown; grant_id?: unknown; actor?: unknown; action?: unknown; at?: unknown }; signature?: unknown };
      try {
        const text = await readCapped(request.clone(), limits.maxBodyBytes);
        if (text === null) return json(413, { error: "payload_too_large", message: `body is larger than ${limits.maxBodyBytes} bytes` });
        body = JSON.parse(text) as typeof body;
      } catch {
        return json(400, { error: "invalid_request", message: "body is not JSON" });
      }
      const n = body.notice;
      if (!n || typeof body.signature !== "string" || n.action !== "stop" || typeof n.actor !== "string" || typeof n.circle !== "string" || n.grant_id !== grantId || !Number.isSafeInteger(n.at)) {
        return json(400, { error: "invalid_request", message: "notice must be {circle, grant_id, actor, action: stop, at}" });
      }
      if (n.circle !== options.contractId) return json(400, { error: "invalid_request", message: "notice.circle must be the circle contract account" });
      if (Math.abs((n.at as number) - Math.floor(now() / 1000)) > SKEW_SECONDS) return json(400, { error: "invalid_request", message: `notice.at deviates by more than ${SKEW_SECONDS} seconds` });
      if (n.actor !== grant.grantee) return json(403, { error: "not_grantee", message: `grant ${grantId} is rented by ${grant.grantee}` });
      const key = await options.voucherKeyOf(n.actor);
      const text = stopNoticeText({ circle: n.circle, grant_id: grantId, actor: n.actor, at: n.at as number });
      let ok = false;
      try {
        ok = key !== null && verifyHash(nep413SigningHash(text, createHash("sha256").update(text, "utf8").digest(), n.circle), body.signature, key);
      } catch {
        ok = false;
      }
      if (!ok) return json(401, { error: "invalid_signature", message: "notice signature does not match the renter's voucher key" });
      try {
        if (!manager.access(grantId)) return json(404, { error: "access_not_found", message: `grant ${grantId} has no access` });
        await manager.revokeAccess(grantId, "stopped");
        return json(200, await view(grant));
      } catch (error) {
        return fail(error);
      }
    }

    if (request.method === "POST" && !stop) {
      let grant: AccessGrant;
      try {
        grant = await options.dispatcher.open(grantId);
        parseProviderScope(grant.limits.scope);
      } catch (error) {
        return fail(error);
      }
      let body: { grantee_ref?: unknown; proof?: unknown };
      try {
        const text = await readCapped(request.clone(), limits.maxBodyBytes);
        if (text === null) return json(413, { error: "payload_too_large", message: `body is larger than ${limits.maxBodyBytes} bytes` });
        body = JSON.parse(text) as typeof body;
      } catch {
        return json(400, { error: "invalid_request", message: "body is not JSON {grantee_ref, proof?}" });
      }
      const scope = parseProviderScope(grant.limits.scope);
      if (typeof body.grantee_ref !== "string" || (body.proof !== undefined && body.proof !== null && typeof body.proof !== "string")) {
        return json(400, { error: "invalid_request", message: "body must be {grantee_ref, proof?} as text" });
      }
      // the reference is fixed in the scope of the grant on the chain: asking for another one is how a grant would be moved to another account
      if (body.grantee_ref !== scope.grantee_ref) return json(403, { error: "grantee_ref_mismatch", message: "grantee_ref must match the one written in the grant scope" });
      const charge = meterGrant(grant, { quantity: 1 });
      const middleware = x207Middleware({
        routes: { [url.pathname]: { price: options.creditPrice(charge.amount), description: `Rent of access ${grantId}`, grant: () => ({ grantId, payTo: grant.grantor }) } },
        facilitatorUrl: options.facilitatorUrl, circleId: options.circleId, payTo: options.brokerAccount, extra: options.extra, ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      const answer = await guardVoucher(request, () => middleware(request, async (paid) => {
        const header = paid.headers.get("PAYMENT-SIGNATURE");
        let payer: string | undefined;
        try {
          payer = (JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8")) as { payload?: { voucher?: { payer?: string } } }).payload?.voucher?.payer;
        } catch {
          payer = undefined;
        }
        if (payer !== grant.grantee) return json(403, { error: "payer_not_grantee", message: `grant ${grantId} is rented by ${grant.grantee}` });
        try {
          const { access, delivery, warnings } = await manager.grantAccess(grant, 1, typeof body.proof === "string" ? body.proof : null);
          return json(200, { ...(await view(grant)), paidUntil: iso(access.paidUntilMs), delivery, warnings });
        } catch (error) {
          return fail(error);
        }
      }));
      // B7-P7: the answer with the key is the one that reached the settle; a 402 or a 5xx replaced it, so the key stays pending and the next paid request makes a new one
      if (answer.status === 200) manager.confirmDelivery(grantId);
      return answer;
    }
    return json(404, { error: "not_found" });
  };
}
