import { resolveEpoch } from "../epoch-param.js";
import { ApiError, invalidRequest } from "../errors.js";
import { amount, DECIMALS, isoFromNs, row, rows, UNIT } from "../format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import type { Route } from "../router.js";

const STATUSES = ["due", "paid", "defaulted", "claimable", "claimed"] as const;

interface SettlementRow {
  epoch: bigint;
  account_id: string;
  role: "debtor" | "creditor" | "none";
  net: bigint;
  amount: bigint;
  status: string | null;
  due_at_ns: bigint | null;
  paid_amount: bigint;
  stake_slashed: bigint;
  haircut: bigint;
  destination: string | null;
  tx_hash: string | null;
  phase: string;
}

const COLUMNS = `s.epoch, s.account_id, s.role, s.net, s.amount, s.status, s.due_at_ns, s.paid_amount, s.stake_slashed,
  s.haircut, s.destination, s.tx_hash, e.phase`;

/** Posisi bersih bertanda: `+45000000`, `-35000000`, `0` (Spec API Backend 3.4). */
const signed = (net: bigint): string => (net > 0n ? `+${net}` : net.toString());

function item(r: SettlementRow, withAccount: boolean) {
  return {
    ...(withAccount ? { account: r.account_id } : {}),
    epoch: Number(r.epoch),
    phase: r.phase,
    role: r.role,
    net: signed(r.net),
    amount: amount(r.amount),
    status: r.status,
    // `claim` hanya boleh setelah `finalize_epoch` (ADR-24).
    claimableNow: r.status === "claimable" && r.phase === "finalized",
    destination: r.destination,
    txHash: r.tx_hash,
    ...(r.role === "debtor"
      ? {
          due: isoFromNs(r.due_at_ns),
          paidAmount: amount(r.paid_amount),
          stakeSlashed: amount(r.stake_slashed),
          haircut: amount(r.haircut),
        }
      : {}),
  };
}

function statusFilter(query: URLSearchParams): string | null {
  const status = query.get("status");
  if (status !== null && !(STATUSES as readonly string[]).includes(status)) {
    throw invalidRequest("unknown status", { status, allowed: STATUSES });
  }
  return status;
}

/** BE-016: tagihan dan klaim per anggota (epoch turun) dan per epoch (akun naik). */
export const settlementRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/members/{account}/settlements",
    circleScoped: true,
    handler: ({ db, circle, params, query }) => {
      const account = params.account as string;
      const limit = parseLimit(query);
      const status = statusFilter(query);
      const cursor = decodeCursor(query);
      const before = cursor && typeof cursor.e === "number" && Number.isInteger(cursor.e) ? cursor.e : null;
      if (cursor && before === null) throw invalidRequest("invalid cursor");
      if (!row(db, "SELECT 1 AS one FROM members WHERE circle_id = ? AND account_id = ?", circle.circle_id, account)) {
        throw new ApiError(404, "member_not_found", `Member ${account} is not registered`, { circle: circle.circle_id, account });
      }
      const found = rows<SettlementRow>(
        db,
        `SELECT ${COLUMNS} FROM settlements s JOIN epochs e ON e.circle_id = s.circle_id AND e.epoch = s.epoch
         WHERE s.circle_id = ? AND s.account_id = ? AND (? IS NULL OR s.status = ?) AND (? IS NULL OR s.epoch < ?)
         ORDER BY s.epoch DESC LIMIT ?`,
        circle.circle_id, account, status, status, before, before, limit + 1,
      );
      const page = found.slice(0, limit);
      const last = page[page.length - 1];
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          unit: UNIT,
          decimals: DECIMALS,
          items: page.map((r) => item(r, false)),
          nextCursor: found.length > limit && last ? encodeCursor({ e: Number(last.epoch) }) : null,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/epochs/{n}/settlements",
    circleScoped: true,
    handler: (ctx) => {
      const { db, circle, query } = ctx;
      const limit = parseLimit(query);
      const status = statusFilter(query);
      const cursor = decodeCursor(query);
      const after = cursor && typeof cursor.a === "string" ? cursor.a : null;
      if (cursor && after === null) throw invalidRequest("invalid cursor");
      const epoch = resolveEpoch(ctx);
      const found = rows<SettlementRow>(
        db,
        `SELECT ${COLUMNS} FROM settlements s JOIN epochs e ON e.circle_id = s.circle_id AND e.epoch = s.epoch
         WHERE s.circle_id = ? AND s.epoch = ? AND (? IS NULL OR s.status = ?) AND (? IS NULL OR s.account_id > ?)
         ORDER BY s.account_id LIMIT ?`,
        circle.circle_id, epoch.epoch, status, status, after, after, limit + 1,
      );
      const page = found.slice(0, limit);
      const last = page[page.length - 1];
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          epoch: Number(epoch.epoch),
          unit: UNIT,
          decimals: DECIMALS,
          items: page.map((r) => item(r, true)),
          nextCursor: found.length > limit && last ? encodeCursor({ a: last.account_id }) : null,
        },
      };
    },
  },
];
