import { ApiError, invalidRequest } from "../errors.js";
import { amount, DECIMALS, row, rows, UNIT } from "../format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import type { Route } from "../router.js";

const STATUSES = ["offered", "active", "revoked", "expired"] as const;

interface GrantRow {
  grant_id: bigint;
  asset_type: string;
  grantor: string;
  grantee: string | null;
  class: string;
  unit: string;
  unit_price: bigint;
  expires_at_ns: bigint;
  delivery_pubkey: string | null;
  status: string;
  revoke_reason: string | null;
  block_height: bigint;
}

const COLUMNS = "grant_id, asset_type, grantor, grantee, class, unit, unit_price, expires_at_ns, delivery_pubkey, status, revoke_reason, block_height";

interface EscrowRow {
  grant_id: bigint;
  kind: string;
  nft_contract: string | null;
  token_id: string | null;
  ft_contract: string | null;
  mt_contract: string | null;
  amount: string | null;
  state: string;
}

/** Class A grants carry the escrow that holds the asset; other grants have `escrow: null`. */
function escrowsOf(db: Parameters<typeof rows>[0], circleId: string, ids: readonly bigint[]): Map<bigint, EscrowRow> {
  if (ids.length === 0) return new Map();
  const found = rows<EscrowRow>(
    db, `SELECT grant_id, kind, nft_contract, token_id, ft_contract, mt_contract, amount, state FROM escrows WHERE circle_id = ? AND grant_id IN (${ids.map(() => "?").join(",")})`, circleId, ...ids,
  );
  return new Map(found.map((e) => [e.grant_id, e]));
}

/** `kind` `nft`: the NFT and its token. `kind` `ft` (CT-090): the token contract and the exact amount, in the units of that token (a decimal string, not credits). `kind` `mt` (CT-092): the multi-token contract, the token id and the amount. */
const escrowView = (e: EscrowRow | undefined) =>
  e === undefined
    ? null
    : e.kind === "ft"
      ? { kind: "ft", ftContract: e.ft_contract, amount: String(e.amount), state: e.state }
      : e.kind === "mt"
        ? { kind: "mt", mtContract: e.mt_contract, tokenId: e.token_id, amount: String(e.amount), state: e.state }
        : { kind: "nft", nftContract: e.nft_contract, tokenId: e.token_id, state: e.state };

function view(g: GrantRow, escrow?: EscrowRow) {
  return {
    escrow: escrowView(escrow),
    grantId: Number(g.grant_id),
    assetType: g.asset_type,
    grantor: g.grantor,
    grantee: g.grantee,
    class: g.class,
    unit: g.unit,
    unitPrice: amount(g.unit_price),
    expiresAt: g.expires_at_ns.toString(),
    deliveryPubkey: g.delivery_pubkey,
    status: g.status,
    revokeReason: g.revoke_reason,
    changedBlock: Number(g.block_height),
  };
}

/** BE-038 (F8): D11 grants as the events tell them. `grantee` and `grantor` filter by account, `status` by state. */
export const grantRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/grants",
    circleScoped: true,
    handler: ({ db, circle, query }) => {
      const status = query.get("status");
      if (status !== null && !(STATUSES as readonly string[]).includes(status)) throw invalidRequest("unknown status", { status, allowed: STATUSES });
      const grantee = query.get("grantee");
      const grantor = query.get("grantor");
      const limit = parseLimit(query);
      const cursor = decodeCursor(query);
      const after = cursor === null ? 0 : Number((cursor as { id?: number }).id ?? 0);
      const page = rows<GrantRow>(
        db,
        `SELECT ${COLUMNS} FROM grants
         WHERE circle_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR grantee = ?) AND (? IS NULL OR grantor = ?) AND grant_id > ?
         ORDER BY grant_id LIMIT ?`,
        circle.circle_id, status, status, grantee, grantee, grantor, grantor, after, limit + 1,
      );
      const more = page.length > limit;
      const shown = more ? page.slice(0, limit) : page;
      const escrows = escrowsOf(db, circle.circle_id, shown.map((g) => g.grant_id));
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          unit: UNIT,
          decimals: DECIMALS,
          items: shown.map((g) => view(g, escrows.get(g.grant_id))),
          nextCursor: more ? encodeCursor({ id: Number(shown[shown.length - 1]!.grant_id) }) : null,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/grants/{grantId}",
    circleScoped: true,
    handler: ({ db, circle, params }) => {
      const id = Number(params.grantId);
      if (!Number.isSafeInteger(id) || id < 1) throw invalidRequest("grantId must be a positive integer", { grantId: params.grantId as string });
      const found = row<GrantRow>(db, `SELECT ${COLUMNS} FROM grants WHERE circle_id = ? AND grant_id = ?`, circle.circle_id, id);
      if (!found) throw new ApiError(404, "grant_not_found", `Grant ${id} not found`, { grantId: id });
      return { status: 200, body: { circle: circle.circle_id, decimals: DECIMALS, ...view(found, escrowsOf(db, circle.circle_id, [found.grant_id]).get(found.grant_id)) } };
    },
  },
];
