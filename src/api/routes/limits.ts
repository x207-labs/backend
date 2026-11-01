import { ApiError, invalidRequest } from "../errors.js";
import { amount, DECIMALS, row, rows, UNIT } from "../format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import type { Route } from "../router.js";

interface LimitRow {
  id: bigint;
  epoch: bigint | null;
  old_limit: bigint;
  new_limit: bigint;
  status: string;
  reason: string;
  block_height: bigint;
}

/** `GET …/members/{account}/limits` (Spec API Backend 2.1, BE-011): riwayat limit, terbaru dulu. */
export const limitRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/members/{account}/limits",
    circleScoped: true,
    handler: ({ db, circle, params, query }) => {
      const account = params.account as string;
      const limit = parseLimit(query);
      const cursor = decodeCursor(query);
      const after = cursor && typeof cursor.a === "number" ? cursor.a : null;
      if (cursor && after === null) throw invalidRequest("cursor tidak valid");

      if (!row(db, "SELECT 1 AS one FROM members WHERE circle_id = ? AND account_id = ?", circle.circle_id, account)) {
        throw new ApiError(404, "member_not_found", `Anggota ${account} tidak terdaftar`, { circle: circle.circle_id, account });
      }
      const found = rows<LimitRow>(
        db,
        `SELECT id, epoch, old_limit, new_limit, status, reason, block_height FROM member_limits
         WHERE circle_id = ? AND account_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
        circle.circle_id, account, after, after, limit + 1,
      );
      const page = found.slice(0, limit);
      const last = page[page.length - 1];
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          unit: UNIT,
          decimals: DECIMALS,
          items: page.map((r) => ({
            epoch: r.epoch === null ? null : Number(r.epoch),
            oldLimit: amount(r.old_limit),
            newLimit: amount(r.new_limit),
            status: r.status,
            reason: r.reason,
            blockHeight: Number(r.block_height),
          })),
          nextCursor: found.length > limit && last ? encodeCursor({ a: Number(last.id) }) : null,
        },
      };
    },
  },
];
