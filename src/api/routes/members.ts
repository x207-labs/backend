import { ApiError, invalidRequest } from "../errors.js";
import { amount, DECIMALS, isoFromNs, row, rows, UNIT } from "../format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import type { Route } from "../router.js";

const MEMBER_STATUSES = ["pending", "active", "suspended", "exited"] as const;

interface MemberRow {
  account_id: string;
  status: string;
  stake: bigint;
  credit_limit: bigint;
  outstanding_debt: bigint;
  terms_hash: string;
  pubkey_voucher: string;
  settled_history: bigint;
  joined_at_ns: bigint;
  exit_requested_epoch: bigint | null;
}

const MEMBER_COLUMNS = `account_id, status, stake, credit_limit, outstanding_debt, terms_hash, pubkey_voucher,
  settled_history, joined_at_ns, exit_requested_epoch`;

/** Headroom on-chain = limit − outstandingDebt; 0 untuk anggota yang tidak `active` (view `headroom` kontrak). */
function headroom(m: MemberRow): bigint {
  if (m.status !== "active") return 0n;
  const diff = m.credit_limit - m.outstanding_debt;
  return diff > 0n ? diff : 0n;
}

function memberView(m: MemberRow) {
  return {
    account: m.account_id,
    status: m.status,
    stake: amount(m.stake),
    limit: amount(m.credit_limit),
    outstandingDebt: amount(m.outstanding_debt),
    headroom: amount(headroom(m)),
    termsHash: m.terms_hash,
    pubkeyVoucher: m.pubkey_voucher,
    settledHistory: amount(m.settled_history),
    joinedAt: isoFromNs(m.joined_at_ns),
    exitRequestedEpoch: m.exit_requested_epoch === null ? null : Number(m.exit_requested_epoch),
  };
}

export const memberRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/members",
    circleScoped: true,
    handler: ({ db, circle, query }) => {
      const limit = parseLimit(query);
      const status = query.get("status");
      if (status !== null && !(MEMBER_STATUSES as readonly string[]).includes(status)) {
        throw invalidRequest("status tidak dikenal", { status, allowed: MEMBER_STATUSES });
      }
      const cursor = decodeCursor(query);
      const after = cursor && typeof cursor.a === "string" ? cursor.a : null;
      if (cursor && after === null) throw invalidRequest("cursor tidak valid");

      const found = rows<MemberRow>(
        db,
        `SELECT ${MEMBER_COLUMNS} FROM members
         WHERE circle_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR account_id > ?)
         ORDER BY account_id LIMIT ?`,
        circle.circle_id,
        status,
        status,
        after,
        after,
        limit + 1,
      );
      const page = found.slice(0, limit);
      const last = page[page.length - 1];
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          unit: UNIT,
          decimals: DECIMALS,
          items: page.map(memberView),
          nextCursor: found.length > limit && last ? encodeCursor({ a: last.account_id }) : null,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/members/{account}",
    circleScoped: true,
    handler: ({ db, circle, params }) => {
      const account = params.account as string;
      const m = row<MemberRow>(
        db,
        `SELECT ${MEMBER_COLUMNS} FROM members WHERE circle_id = ? AND account_id = ?`,
        circle.circle_id,
        account,
      );
      if (!m) {
        throw new ApiError(404, "member_not_found", `Anggota ${account} tidak terdaftar`, {
          circle: circle.circle_id,
          account,
        });
      }
      return {
        status: 200,
        body: { circle: circle.circle_id, unit: UNIT, decimals: DECIMALS, ...memberView(m) },
      };
    },
  },
];
