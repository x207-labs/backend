import type Database from "better-sqlite3";
import type { X207EventMap, X207EventName } from "@x207/core";
import { IndexerHaltError } from "../errors.js";

export interface HandlerContext {
  db: Database.Database;
  circleId: string;
  block: { height: number; hash: string; timestampNs: bigint };
  receiptId: string;
  logIndex: number;
  txHash: string | null;
}

export type Handler<E extends X207EventName> = (ctx: HandlerContext, data: X207EventMap[E]) => void;
export type HandlerMap = { [E in X207EventName]?: Handler<E> };

const PHASE_RANK = "CASE phase WHEN 'open' THEN 0 WHEN 'clearing' THEN 1 WHEN 'payment_window' THEN 2 ELSE 3 END";
export type Phase = "open" | "clearing" | "payment_window" | "finalized";
const RANK: Record<Phase, number> = { open: 0, clearing: 1, payment_window: 2, finalized: 3 };

export function ensureEpoch(ctx: HandlerContext, epoch: number): void {
  ctx.db.prepare("INSERT OR IGNORE INTO epochs (circle_id, epoch, phase) VALUES (?, ?, 'open')").run(ctx.circleId, epoch);
}

/** Phase only moves forward (Spec Skema D9 5.2); returns true if the phase changed. */
export function advancePhase(ctx: HandlerContext, epoch: number, to: Phase): boolean {
  const result = ctx.db
    .prepare(`UPDATE epochs SET phase = ? WHERE circle_id = ? AND epoch = ? AND ${PHASE_RANK} < ?`)
    .run(to, ctx.circleId, epoch, RANK[to]);
  return result.changes > 0;
}

export function memberLimit(ctx: HandlerContext, account: string): bigint {
  const row = ctx.db
    .prepare("SELECT credit_limit FROM members WHERE circle_id = ? AND account_id = ?")
    .safeIntegers(true)
    .get(ctx.circleId, account) as { credit_limit: bigint } | undefined;
  if (!row) throw new IndexerHaltError(`unknown member ${account} in D9`);
  return row.credit_limit;
}

export function requireChange(changes: number, what: string): void {
  if (changes === 0) throw new IndexerHaltError(`${what} not found in D9`);
}

export function recordLimit(
  ctx: HandlerContext,
  row: { account: string; epoch: number | null; oldLimit: bigint; newLimit: bigint; status: string; reason: "stake" | "finalize" | "default" | "ruling" },
): void {
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO member_limits (circle_id, account_id, epoch, old_limit, new_limit, status, reason,
         block_height, receipt_id, log_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.circleId, row.account, row.epoch, row.oldLimit, row.newLimit, row.status, row.reason, ctx.block.height, ctx.receiptId, ctx.logIndex);
}
