import { invalidRequest } from "../errors.js";
import { amount, DECIMALS, row, rows, UNIT } from "../format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import type { Route } from "../router.js";

const STATUSES = ["posted", "removed"] as const;

interface IntentRow {
  id: bigint;
  intent_hash: string;
  account_id: string;
  status: string;
  posted_at_ns: bigint;
  block_height: bigint;
  removed_block_height: bigint | null;
}

interface WithdrawalRow {
  id: bigint;
  amount: bigint;
  block_height: bigint;
  receipt_id: string;
}

/**
 * Interface 0.0.9, read from the events. `GET /x207/circles/{circle}/intents/hashes?account=&status=posted|removed` lists the hashes that members posted on chain
 * (newest first); a removed intent is `removed`, not deleted, so a consumer can tell it from one that was never posted. `GET /x207/circles/{circle}/intents/withdrawals`
 * lists the withdrawals from Intents (`withdraw_intents_balance`) newest first, with the total withdrawn so far. The balance still booked at Intents is NOT here:
 * `residual_paid` is the same event whether the debtor paid by `ft_on_transfer` or by `mt_on_transfer`, so the events do not say how much sits at Intents;
 * the view `intents_balance` of the contract does.
 */
export const intentRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/intents/hashes",
    circleScoped: true,
    handler: ({ db, circle, query }) => {
      const status = query.get("status") ?? "posted";
      if (!(STATUSES as readonly string[]).includes(status)) throw invalidRequest("unknown status", { status, allowed: STATUSES });
      const account = query.get("account");
      const limit = parseLimit(query);
      const cursor = decodeCursor(query);
      const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number((cursor as { id?: number }).id ?? Number.MAX_SAFE_INTEGER);
      const page = rows<IntentRow>(
        db,
        `SELECT rowid AS id, intent_hash, account_id, status, posted_at_ns, block_height, removed_block_height FROM intent_book
         WHERE circle_id = ? AND status = ? AND (? IS NULL OR account_id = ?) AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
        circle.circle_id, status, account, account, before, limit + 1,
      );
      const more = page.length > limit;
      const shown = more ? page.slice(0, limit) : page;
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          items: shown.map((i) => ({
            intentHash: i.intent_hash,
            accountId: i.account_id,
            status: i.status,
            postedAtNs: i.posted_at_ns.toString(),
            changedBlock: Number(i.removed_block_height ?? i.block_height),
          })),
          nextCursor: more ? encodeCursor({ id: Number(shown[shown.length - 1]!.id) }) : null,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/intents/withdrawals",
    circleScoped: true,
    handler: ({ db, circle, query }) => {
      const limit = parseLimit(query);
      const cursor = decodeCursor(query);
      const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number((cursor as { id?: number }).id ?? Number.MAX_SAFE_INTEGER);
      const page = rows<WithdrawalRow>(
        db,
        "SELECT rowid AS id, amount, block_height, receipt_id FROM intent_withdrawals WHERE circle_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?",
        circle.circle_id, before, limit + 1,
      );
      const more = page.length > limit;
      const shown = more ? page.slice(0, limit) : page;
      const total = row<{ total: bigint | null; n: bigint }>(db, "SELECT SUM(amount) AS total, COUNT(*) AS n FROM intent_withdrawals WHERE circle_id = ?", circle.circle_id);
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          unit: UNIT,
          decimals: DECIMALS,
          totalWithdrawn: amount(total?.total ?? 0n),
          withdrawals: Number(total?.n ?? 0n),
          items: shown.map((w) => ({ amount: amount(w.amount), changedBlock: Number(w.block_height), receiptId: w.receipt_id })),
          nextCursor: more ? encodeCursor({ id: Number(shown[shown.length - 1]!.id) }) : null,
        },
      };
    },
  },
];
