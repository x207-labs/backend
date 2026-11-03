import { ApiError, invalidRequest } from "../errors.js";
import { amount, DECIMALS, isoFromNs, row, rows, UNIT } from "../format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import type { Route } from "../router.js";

// Interface 0.0.12 (BE-065): the deals with a bond, the freezes, and the official contracts, from D9 (see `indexer/handlers/rules.ts`).
const DEAL_STATES = ["open", "disputed", "closed"] as const;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

interface DealRow {
  bundle_id: bigint;
  party_a: string;
  party_b: string | null;
  bond_each: bigint;
  locked_a: bigint;
  locked_b: bigint;
  state: string;
  complainant: string | null;
  accused: string | null;
  evidence_hash: string | null;
  disputed_at_ns: bigint | null;
  arbiter: string | null;
  verdict: string | null;
  opened_block: bigint;
  closed_block: bigint | null;
}

function dealView(d: DealRow) {
  const parties = d.party_b === null ? [d.party_a] : [d.party_a, d.party_b];
  return {
    bundleId: Number(d.bundle_id),
    parties,
    bondEach: amount(d.bond_each),
    // per party, in the order of `parties`: whether its bond is still locked
    locked: d.party_b === null ? [d.locked_a === 1n] : [d.locked_a === 1n, d.locked_b === 1n],
    state: d.state,
    complainant: d.complainant,
    accused: d.accused,
    evidenceHash: d.evidence_hash,
    disputedAt: isoFromNs(d.disputed_at_ns),
    // known from the event of the ruling; `get_deal` of the contract names the arbiter and `confirm_by` of a deal that is open
    arbiter: d.arbiter,
    verdict: d.verdict,
    openedBlock: Number(d.opened_block),
    closedBlock: d.closed_block === null ? null : Number(d.closed_block),
  };
}

interface FreezeRow {
  account_id: string;
  state: string;
  eta_ns: bigint | null;
  reason_hash: string | null;
  from_epoch: bigint | null;
}
const freezeView = (f: FreezeRow) => ({
  account: f.account_id, state: f.state, frozen: f.state === "frozen", eta: isoFromNs(f.eta_ns), reasonHash: f.reason_hash, fromEpoch: f.from_epoch === null ? null : Number(f.from_epoch),
});

export const ruleRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/deals",
    circleScoped: true,
    handler: ({ db, circle, query }) => {
      const limit = parseLimit(query);
      const cursor = decodeCursor(query);
      const account = query.get("account");
      const state = query.get("state") ?? "all";
      if (account !== null && !ACCOUNT.test(account)) throw invalidRequest("account bukan account id", { account });
      if (state !== "all" && !(DEAL_STATES as readonly string[]).includes(state)) throw invalidRequest("state tidak dikenal", { state, allowed: [...DEAL_STATES, "all"] });
      let after = Number.MAX_SAFE_INTEGER;
      if (cursor) {
        if (typeof cursor.a !== "number" || !Number.isSafeInteger(cursor.a)) throw invalidRequest("cursor tidak valid");
        after = cursor.a;
      }
      const found = rows<DealRow>(
        db,
        `SELECT * FROM deals WHERE circle_id = ? AND bundle_id < ? AND (? = 'all' OR state = ?) AND (? IS NULL OR party_a = ? OR party_b = ?) ORDER BY bundle_id DESC LIMIT ?`,
        circle.circle_id, after, state, state, account, account, account, limit + 1,
      );
      const page = found.slice(0, limit);
      const last = page[page.length - 1];
      // the bonds that an account has locked now, over every open deal (not only this page)
      const bondLocked =
        account === null
          ? null
          : amount(
              row<{ n: bigint }>(
                db,
                `SELECT COALESCE(SUM(CASE WHEN party_a = ? AND locked_a = 1 THEN bond_each ELSE 0 END + CASE WHEN party_b = ? AND locked_b = 1 THEN bond_each ELSE 0 END), 0) AS n
                 FROM deals WHERE circle_id = ? AND state != 'closed'`,
                account, account, circle.circle_id,
              )?.n ?? 0n,
            );
      return {
        status: 200,
        body: { circle: circle.circle_id, unit: UNIT, decimals: DECIMALS, ...(bondLocked === null ? {} : { account, bondLocked }), items: page.map(dealView), nextCursor: found.length > limit && last ? encodeCursor({ a: Number(last.bundle_id) }) : null },
      };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/deals/{bundleId}",
    circleScoped: true,
    handler: ({ db, circle, params }) => {
      if (!/^(0|[1-9]\d*)$/.test(params.bundleId as string)) throw invalidRequest("bundleId harus bilangan bulat >= 0", { bundleId: params.bundleId });
      const d = row<DealRow>(db, "SELECT * FROM deals WHERE circle_id = ? AND bundle_id = ?", circle.circle_id, BigInt(params.bundleId as string));
      if (!d) throw new ApiError(404, "deal_not_found", `Deal ${params.bundleId} tidak ada`, { bundleId: params.bundleId });
      const events = rows<{ event: string; account_id: string | null; amount: bigint | null; detail: string | null; block_height: bigint }>(
        db,
        "SELECT event, account_id, amount, detail, block_height FROM deal_events WHERE circle_id = ? AND bundle_id = ? ORDER BY id",
        circle.circle_id, d.bundle_id,
      );
      return {
        status: 200,
        body: {
          circle: circle.circle_id, unit: UNIT, decimals: DECIMALS, ...dealView(d),
          history: events.map((e) => ({ event: e.event, account: e.account_id, amount: e.amount === null ? null : amount(e.amount), detail: e.detail, block: Number(e.block_height) })),
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/freezes",
    circleScoped: true,
    handler: ({ db, circle, query }) => {
      const state = query.get("state");
      if (state !== null && state !== "pending" && state !== "frozen") throw invalidRequest("state harus pending atau frozen", { state });
      const found = rows<FreezeRow>(db, "SELECT * FROM member_freezes WHERE circle_id = ? AND (? IS NULL OR state = ?) ORDER BY account_id", circle.circle_id, state, state);
      return { status: 200, body: { circle: circle.circle_id, items: found.map(freezeView) } };
    },
  },
  {
    // not frozen is an answer, not an error: `is_frozen` of the contract, as the facilitator asks it
    method: "GET",
    pattern: "/x207/circles/{circle}/members/{account}/freeze",
    circleScoped: true,
    handler: ({ db, circle, params }) => {
      const account = params.account as string;
      if (!row(db, "SELECT 1 AS one FROM members WHERE circle_id = ? AND account_id = ?", circle.circle_id, account)) {
        throw new ApiError(404, "member_not_found", `Anggota ${account} tidak terdaftar`, { circle: circle.circle_id, account });
      }
      const f = row<FreezeRow>(db, "SELECT * FROM member_freezes WHERE circle_id = ? AND account_id = ?", circle.circle_id, account);
      return { status: 200, body: { circle: circle.circle_id, ...(f ? freezeView(f) : { account, state: null, frozen: false, eta: null, reasonHash: null, fromEpoch: null }) } };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/asset-contracts",
    circleScoped: true,
    handler: ({ db, circle }) => {
      const found = rows<{ asset_type: string; contracts: string; block_height: bigint }>(db, "SELECT asset_type, contracts, block_height FROM official_contracts WHERE circle_id = ? ORDER BY asset_type", circle.circle_id);
      return { status: 200, body: { circle: circle.circle_id, items: found.map((r) => ({ assetType: r.asset_type, contracts: JSON.parse(r.contracts) as string[], block: Number(r.block_height) })) } };
    },
  },
];
