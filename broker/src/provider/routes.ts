// HTTP routes of the rent of a P2 access (BE-060, ADR-47), on the same server as the lease of class B:
//   POST /grants/{grantId}/access        pays one day (x402, like the lease) and asks for the access: body {grantee_ref, proof?}
//   GET  /grants/{grantId}/access        status, the bill of today, and the state of a revoke that is pending
//   POST /grants/{grantId}/access/stop   the lessee ends the rent: body {notice, signature}, signed with its voucher key
// Everything goes through `ProviderAccessManager`: the same checks (`verifyGranteeRef`, native expiry), the same retry of a revoke. Errors are `{error, message}`; the codes are in the README.
import { createHash } from "node:crypto";
import { meterGrant, nep413SigningHash, verifyHash } from "@x207/core";
import { x207Middleware, X207ExtraSource } from "@x207/scheme";
import type { AccessGrant } from "@x207/core";
import { DispatchError, type Dispatcher } from "../dispatcher.js";
import { guardVoucher } from "../in-flight.js";
import { ProviderAccessError, parseProviderScope, type ProviderAccessErrorCode } from "./adapter.js";
import type { ProviderAccessManager } from "./manager.js";

export const ACCESS_PATH = /^\/grants\/(0|[1-9]\d*)\/access(\/stop)?$/;
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
}

export const ERROR_STATUS: Record<ProviderAccessErrorCode, number> = {
  scope_invalid: 400, grantee_ref_unverified: 403, access_not_found: 404, cap_exceeded: 409, provider_unknown: 501, hosted_mode_real_provider: 501, native_expiry_required: 502, grant_failed: 502,
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
      revokePending: a.status === "revoke_pending" ? { attempts: a.attempts, nextRetryAt: iso(a.nextRetryMs), lastError: a.lastError } : null,
      today: { day, cost: cost === null ? null : cost.toString(), billed: manager.charges(grant.grant_id).find((c) => c.day === day)?.amount.toString() ?? null },
      unit: "credit", decimals: 6,
    };
  }

  return async (request) => {
    const url = new URL(request.url);
    const match = ACCESS_PATH.exec(url.pathname);
    if (match === null) return json(404, { error: "not_found" });
    const grantId = Number(match[1]);
    const stop = match[2] !== undefined;

    if (request.method === "GET" && !stop) {
      try {
        const grant = await options.dispatcher.open(grantId).catch(async (e) => {
          // a revoked grant still has an access to look at
          if (e instanceof DispatchError && e.code === "grant_revoked") return null;
          throw e;
        });
        const a = manager.access(grantId);
        if (!a) return json(404, { error: "access_not_found", message: `grant ${grantId} tidak punya akses` });
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
        body = (await request.json()) as typeof body;
      } catch {
        return json(400, { error: "invalid_request", message: "body bukan JSON" });
      }
      const n = body.notice;
      if (!n || typeof body.signature !== "string" || n.action !== "stop" || typeof n.actor !== "string" || typeof n.circle !== "string" || n.grant_id !== grantId || !Number.isSafeInteger(n.at)) {
        return json(400, { error: "invalid_request", message: "notice wajib {circle, grant_id, actor, action: stop, at}" });
      }
      if (n.circle !== options.contractId) return json(400, { error: "invalid_request", message: "notice.circle harus akun kontrak lingkaran" });
      if (Math.abs((n.at as number) - Math.floor(now() / 1000)) > SKEW_SECONDS) return json(400, { error: "invalid_request", message: `notice.at menyimpang lebih dari ${SKEW_SECONDS} detik` });
      if (n.actor !== grant.grantee) return json(403, { error: "not_grantee", message: `grant ${grantId} disewa oleh ${grant.grantee}` });
      const key = await options.voucherKeyOf(n.actor);
      const text = stopNoticeText({ circle: n.circle, grant_id: grantId, actor: n.actor, at: n.at as number });
      let ok = false;
      try {
        ok = key !== null && verifyHash(nep413SigningHash(text, createHash("sha256").update(text, "utf8").digest(), n.circle), body.signature, key);
      } catch {
        ok = false;
      }
      if (!ok) return json(401, { error: "invalid_signature", message: "tanda tangan notice tidak cocok dengan kunci voucher penyewa" });
      try {
        if (!manager.access(grantId)) return json(404, { error: "access_not_found", message: `grant ${grantId} tidak punya akses` });
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
        body = (await request.clone().json()) as typeof body;
      } catch {
        return json(400, { error: "invalid_request", message: "body bukan JSON {grantee_ref, proof?}" });
      }
      const scope = parseProviderScope(grant.limits.scope);
      if (typeof body.grantee_ref !== "string" || (body.proof !== undefined && body.proof !== null && typeof body.proof !== "string")) {
        return json(400, { error: "invalid_request", message: "body wajib {grantee_ref, proof?} berupa teks" });
      }
      // the reference is fixed in the scope of the grant on the chain: asking for another one is how a grant would be moved to another account
      if (body.grantee_ref !== scope.grantee_ref) return json(403, { error: "grantee_ref_mismatch", message: "grantee_ref harus sama dengan yang tertulis di scope grant" });
      const charge = meterGrant(grant, { quantity: 1 });
      const middleware = x207Middleware({
        routes: { [url.pathname]: { price: options.creditPrice(charge.amount), description: `Rent of access ${grantId}`, grant: () => ({ grantId, payTo: grant.grantor }) } },
        facilitatorUrl: options.facilitatorUrl, circleId: options.circleId, payTo: options.brokerAccount, extra: options.extra, ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return guardVoucher(request, () => middleware(request, async (paid) => {
        const header = paid.headers.get("PAYMENT-SIGNATURE");
        let payer: string | undefined;
        try {
          payer = (JSON.parse(Buffer.from(header ?? "", "base64").toString("utf8")) as { payload?: { voucher?: { payer?: string } } }).payload?.voucher?.payer;
        } catch {
          payer = undefined;
        }
        if (payer !== grant.grantee) return json(403, { error: "payer_not_grantee", message: `grant ${grantId} disewa oleh ${grant.grantee}` });
        try {
          const { access, delivery } = await manager.grantAccess(grant, 1, typeof body.proof === "string" ? body.proof : null);
          return json(200, { ...(await view(grant)), paidUntil: iso(access.paidUntilMs), delivery });
        } catch (error) {
          return fail(error);
        }
      }));
    }
    return json(404, { error: "not_found" });
  };
}
