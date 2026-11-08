// BE-110 (P1, UM-076, contract 0.0.18, ADR `docs/adr-0.0.18.md` in `contracts`, branch `p1-0.0.18`): the sale of a NEAR account through a locker and an escrow of kind `account`.
// What the backend adds to the contract, in the order of the ADR:
//   - the listing (1.3, 1.4): the scope is exactly `{"account_id": ...}`; the seller is not the sold account (`ERR_ACCOUNT_SELF`); an account that is a member of the circle is sold only as
//     `near:member_account` and only while it is `active`, admitted and not on its way out; any other account must not be a member;
//   - item #12 (1.1, 1.5): an address derived through Chain Signatures is listed only if the MPC contract never saw a `sign` call of the account. The history comes from an index of
//     transactions (`AccountHistory`); when it is missing or does not answer, the listing is refused (fail closed);
//   - the wait (1.4): a member account may be delivered only after the epoch of the lock has finished. The read `GET account-escrows/{grantId}` says when (`ready`);
//   - the reputation (1.1): when the owner changes, the reputation of the account starts again (`reputation_resets`, applied in `reputation.ts`).
// The names of the asset types: #11, #12 and #13 are those of the catalog (`scripts/lib/asset-catalog.mjs`); `near:member_account` (#14) is the owner-registered entry of the ADR, not in the catalog yet.
import type Database from "better-sqlite3";
import type { Listing } from "@x207/core";
import { ApiError } from "../api/errors.js";
import { row } from "../api/format.js";
import type { Route } from "../api/router.js";
import type { ViewFunction } from "../settlement/intents.js";
import { openEpochResolver } from "./epoch.js";
import type { ListingAsyncCheck, ListingCheck } from "./listings.js";

const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const MEMBER_ASSET = "near:member_account";
const DERIVED_ASSET = "chain-signatures:derived-address";

export type AccountAssetKind = "account" | "derived" | "member";

/** The asset types that go to an account escrow. `derived` is #12 (the sign history is checked), `member` is #14. */
export const ACCOUNT_ASSET_TYPES: Readonly<Record<string, AccountAssetKind>> = {
  "near:named-account": "account",
  "vesting:transferable-lockup": "account",
  [DERIVED_ASSET]: "derived",
  [MEMBER_ASSET]: "member",
};

/** Keys of `detail` that are shown to a buyer and are not checked; the only key that decides what is sold is `account_id`. */
const DISPLAY_KEYS = new Set(["kind", "display", "name", "note", "symbol", "description"]);

export interface AccountHistory {
  /** How many calls of the method `sign` the account made to the MPC contract; `complete` is false when the index could not be read to the end. */
  signCalls(accountId: string): Promise<{ count: number; complete: boolean }>;
}

export interface AccountEscrowOptions {
  /** Where the sign history of an account comes from. Without it, a listing of #12 is refused (501). */
  accountHistory?: AccountHistory;
}

const refuse = (status: number, code: ApiError["code"], message: string, details: Record<string, unknown> = {}): never => {
  throw new ApiError(status, code, message, details);
};

/** The detail of an account listing: a flat JSON object with `account_id` and display keys. */
function accountDetail(detail: unknown, assetType: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(detail ?? ""));
  } catch {
    return refuse(400, "scope_invalid", `detail for ${assetType} must be flat JSON text with account_id`, { assetType });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return refuse(400, "scope_invalid", `detail for ${assetType} must be a JSON object`, { assetType });
  const d = parsed as Record<string, unknown>;
  const foreign = Object.keys(d).filter((k) => k !== "account_id" && !DISPLAY_KEYS.has(k));
  if (!("account_id" in d) || foreign.length > 0) {
    return refuse(400, "scope_invalid", `scope for ${assetType} must contain exactly account_id`, { assetType, missing: "account_id" in d ? [] : ["account_id"], unknown: foreign });
  }
  const id = d.account_id;
  if (typeof id !== "string" || id.length < 2 || id.length > 64 || !ACCOUNT.test(id)) return refuse(400, "scope_invalid", "account_id is not a NEAR account id", { assetType });
  return id;
}

/** What the sale of an account that is a member needs (ADR 1.4); the contract checks the same again at `account_on_lock` and at delivery. */
function memberSellable(db: Database.Database, circleId: string, accountId: string): void {
  const m = row<{ status: string; admitted: bigint; exit_requested_epoch: bigint | null }>(
    db, "SELECT status, admitted, exit_requested_epoch FROM members WHERE circle_id = ? AND account_id = ?", circleId, accountId,
  );
  if (!m) return refuse(400, "account_not_member", `${MEMBER_ASSET} needs a member of this circle; ${accountId} is not one`, { account: accountId });
  const reason = m.status !== "active" ? `status is ${m.status}` : m.admitted !== 1n ? "it is not admitted" : m.exit_requested_epoch !== null ? "it asked to leave" : null;
  if (reason !== null) refuse(400, "account_not_sellable", `${accountId} cannot be sold as a member: ${reason}`, { account: accountId, status: m.status });
}

/**
 * The form of the listing of an account. Runs with the other `ListingCheck`s, before the signature. An asset type that is not in `ACCOUNT_ASSET_TYPES` is not looked at.
 */
export const accountCheck: ListingCheck = (listing: Listing, { db, circleId }) => {
  const offer = (listing as { offer?: { asset_type?: unknown; asset_class?: unknown; quantity?: unknown } }).offer;
  const assetType = offer?.asset_type;
  const kind = typeof assetType === "string" ? ACCOUNT_ASSET_TYPES[assetType] : undefined;
  if (typeof assetType !== "string" || kind === undefined) return;
  if (offer?.asset_class !== "A") refuse(400, "scope_invalid", `offer.asset_class must be A for ${assetType}: an account goes to a class A escrow`, { assetType, assetClass: offer?.asset_class ?? null });
  if (offer?.quantity !== 1) refuse(400, "scope_invalid", `offer.quantity must be 1 for ${assetType}: one account per listing`, { assetType, quantity: offer?.quantity ?? null });
  const registered = row<{ class: string }>(db, "SELECT class FROM asset_classes WHERE circle_id = ? AND asset_type = ?", circleId, assetType);
  if (!registered) refuse(400, "scope_invalid", `asset_type ${assetType} is not registered in the asset class registry (set_asset_class), so its escrow will not work`, { assetType });
  if (registered && registered.class !== "A") refuse(400, "scope_invalid", `asset_type ${assetType} is registered with class ${registered.class}, not A`, { assetType, registeredClass: registered.class });

  const accountId = accountDetail((listing as { detail?: unknown }).detail, assetType);
  // the grantor is paid by the buyer; a seller that sold its own account would be paid into the account the buyer receives (contract: ERR_ACCOUNT_SELF)
  if (accountId === listing.account) refuse(400, "account_self_sale", "the seller must not be the account that is sold: the buyer pays the seller, so use a second account", { account: accountId });
  const isMember = row(db, "SELECT 1 AS x FROM members WHERE circle_id = ? AND account_id = ?", circleId, accountId) !== undefined;
  if (kind === "member") memberSellable(db, circleId, accountId);
  else if (isMember) refuse(400, "account_is_member", `${accountId} is a member of this circle: it can be sold only as ${MEMBER_ASSET}`, { account: accountId });
};

/** Item #12: the sold account has no `sign` call to the MPC contract. Runs after the signature and the duplicate, because it asks the outside. */
export const accountHistoryCheck = (options: AccountEscrowOptions = {}): ListingAsyncCheck => async (listing) => {
  const assetType = (listing as { offer?: { asset_type?: unknown } }).offer?.asset_type;
  if (assetType !== DERIVED_ASSET) return;
  const accountId = accountDetail((listing as { detail?: unknown }).detail, DERIVED_ASSET);
  if (options.accountHistory === undefined) return refuse(501, "account_history_not_configured", "this backend has no index of MPC calls, so an address of Chain Signatures cannot be listed", {});
  let history: { count: number; complete: boolean };
  try {
    history = await options.accountHistory.signCalls(accountId);
  } catch (error) {
    return refuse(503, "account_history_unavailable", "the index of transactions did not answer; try again", { reason: error instanceof Error ? error.message : "unknown" });
  }
  if (history.count > 0) refuse(409, "account_has_sign_history", `${accountId} signed ${history.count} time(s) through the MPC contract: a signature could already exist, so its addresses are not sold`, { account: accountId, signCalls: history.count });
  if (!history.complete) refuse(503, "account_history_unavailable", "the index of transactions could not be read to the end, so the absence of a sign call is not proved", { account: accountId });
};

// ---- the read model --------------------------------------------------------------------------------------------------------------------------------------------------------

interface AccountEscrowRow {
  grant_id: bigint; account_id: string; state: string; locked_at_ns: bigint; new_owner: string | null; asset_type: string | null; block_height: bigint;
}

/**
 * The epoch in which the lock happened: the first epoch that was still open at the time of the lock (`closed_at_ns` later than the lock), else the epoch that is open now.
 * `null` when neither is known yet (no epoch row and no answer of the chain).
 */
function lockedEpoch(db: Database.Database, circleId: string, lockedAtNs: bigint, openEpoch: number | null): number | null {
  const closed = row<{ epoch: bigint }>(db, "SELECT epoch FROM epochs WHERE circle_id = ? AND closed_at_ns > ? ORDER BY epoch LIMIT 1", circleId, lockedAtNs);
  if (closed) return Number(closed.epoch);
  return openEpoch;
}

/** `GET /x207/circles/{circle}/account-escrows/{grantId}`: where the sale of an account stands, and from when it may be delivered (ADR 1.4: one full epoch for a member account). */
export function accountEscrowRoutes(chainView?: ViewFunction): Route[] {
  const resolve = openEpochResolver(chainView);
  return [
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/account-escrows/{grantId}",
      circleScoped: true,
      handler: async ({ db, circle, params }) => {
        const id = String(params.grantId);
        const found = /^\d{1,15}$/.test(id)
          ? row<AccountEscrowRow>(
              db,
              `SELECT a.grant_id, a.account_id, a.state, a.locked_at_ns, a.new_owner, a.block_height, g.asset_type
                 FROM account_escrows a LEFT JOIN grants g ON g.circle_id = a.circle_id AND g.grant_id = a.grant_id
                WHERE a.circle_id = ? AND a.grant_id = ?`,
              circle.circle_id, Number(id),
            )
          : undefined;
        if (!found) throw new ApiError(404, "account_escrow_not_found", `No account escrow for grant ${id}`, { grantId: id });
        const open = await resolve(db, circle);
        const locked = lockedEpoch(db, circle.circle_id, found.locked_at_ns, open);
        const member = found.asset_type === MEMBER_ASSET;
        const phase = locked === null ? null : row<{ phase: string }>(db, "SELECT phase FROM epochs WHERE circle_id = ? AND epoch = ?", circle.circle_id, locked)?.phase ?? null;
        const waitOver = !member || (locked !== null && open !== null && open > locked && phase === "finalized");
        const reset = row<{ since_ms: bigint }>(db, "SELECT MAX(since_ms) AS since_ms FROM reputation_resets WHERE circle_id = ? AND account_id = ?", circle.circle_id, found.account_id);
        return {
          status: 200,
          body: {
            grantId: Number(found.grant_id),
            account: found.account_id,
            assetType: found.asset_type,
            state: found.state,
            newOwner: found.new_owner,
            member,
            lockedEpoch: locked,
            lockedEpochFinalized: phase === "finalized",
            openEpoch: open,
            // a member account waits until the epoch of the lock is finished and finalized; any other account needs no wait
            waitOver,
            ready: found.state === "held" && waitOver,
            reputationResetAt: reset?.since_ms === null || reset === undefined ? null : new Date(Number(reset.since_ms)).toISOString().replace(/\.\d{3}Z$/, "Z"),
          },
        };
      },
    },
  ];
}
