import type { HandlerMap } from "./context.js";
import { units } from "../units.js";

/** BE-010: pembayaran residual dan klaim kreditor. */
export const settlementHandlers: HandlerMap = {
  residual_paid(ctx, e) {
    const amount = units(e.amount, "amount");
    const paid = ctx.db
      .prepare(
        `UPDATE settlements SET status = 'paid', paid_amount = ?, tx_hash = ?, updated_block = ?
         WHERE circle_id = ? AND epoch = ? AND account_id = ? AND status = 'due'`,
      )
      .run(amount, ctx.txHash, ctx.block.height, ctx.circleId, e.epoch, e.account_id);
    if (paid.changes === 0) return;
    ctx.db
      .prepare(
        `UPDATE members SET outstanding_debt = MAX(outstanding_debt - ?, 0), settled_history = ?, updated_block = ?
         WHERE circle_id = ? AND account_id = ?`,
      )
      .run(amount, units(e.settled_history, "settled_history"), ctx.block.height, ctx.circleId, e.account_id);
  },

  residual_claimed(ctx, e) {
    ctx.db
      .prepare(
        `UPDATE settlements SET status = 'claimed', destination = ?, tx_hash = ?, updated_block = ?
         WHERE circle_id = ? AND epoch = ? AND account_id = ? AND status = 'claimable'`,
      )
      .run(e.destination, ctx.txHash, ctx.block.height, ctx.circleId, e.epoch, e.account_id);
  },

  residual_claim_failed(ctx, e) {
    // Gagal penuh: sudah `claimable`. Sebagian: kembali dari `claimed` dengan sisa yang dipulihkan (ADR-24).
    ctx.db
      .prepare(
        `UPDATE settlements SET status = 'claimable', amount = ?, destination = NULL, tx_hash = NULL, updated_block = ?
         WHERE circle_id = ? AND epoch = ? AND account_id = ? AND status IN ('claimable', 'claimed')`,
      )
      .run(units(e.amount, "amount"), ctx.block.height, ctx.circleId, e.epoch, e.account_id);
  },
};
