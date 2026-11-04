import type { HandlerMap } from "./context.js";
import { ensureEpoch, requireChange } from "./context.js";
import { units } from "../units.js";

/** BE-008: `voucher_registered` (both `cumulative` and `per_request` modes). */
export const voucherHandlers: HandlerMap = {
  voucher_registered(ctx, e) {
    ensureEpoch(ctx, e.epoch);
    // Monotonic guard (Spec Skema D9 5.2): a seq that does not increase leaves the row unchanged.
    const upsert = ctx.db
      .prepare(
        `INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, cleared,
           registration_mode, registered_block, receipt_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
         ON CONFLICT (circle_id, epoch, debtor, creditor) DO UPDATE SET
           seq = excluded.seq, cumulative_amount = excluded.cumulative_amount,
           registration_mode = excluded.registration_mode, registered_block = excluded.registered_block,
           receipt_id = excluded.receipt_id
         WHERE excluded.seq > obligations.seq`,
      )
      .run(ctx.circleId, e.epoch, e.payer, e.payee, e.seq, units(e.cumulative_amount, "cumulative_amount"), e.mode, ctx.block.height, ctx.receiptId);
    if (upsert.changes === 0) return;
    const debt = ctx.db
      .prepare("UPDATE members SET outstanding_debt = ?, updated_block = ? WHERE circle_id = ? AND account_id = ?")
      .run(units(e.outstanding_debt, "outstanding_debt"), ctx.block.height, ctx.circleId, e.payer);
    requireChange(debt.changes, `member ${e.payer}`);
  },
};
