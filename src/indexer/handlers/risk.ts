import type { HandlerMap } from "./context.js";
import { advancePhase, memberLimit, recordLimit, requireChange } from "./context.js";
import { ns, units } from "../units.js";

/** BE-011: default debtor, pembaruan limit, finalisasi epoch. */
export const riskHandlers: HandlerMap = {
  member_defaulted(ctx, e) {
    const defaulted = ctx.db
      .prepare(
        `UPDATE settlements SET status = 'defaulted', stake_slashed = ?, reserve_used = ?, shortfall = ?, updated_block = ?
         WHERE circle_id = ? AND epoch = ? AND account_id = ? AND status = 'due'`,
      )
      .run(units(e.from_stake, "from_stake"), units(e.from_reserve, "from_reserve"), units(e.shortfall, "shortfall"), ctx.block.height, ctx.circleId, e.epoch, e.account_id);
    if (defaulted.changes === 0) return;
    const oldLimit = memberLimit(ctx, e.account_id);
    ctx.db
      .prepare(
        `UPDATE members SET status = 'suspended', credit_limit = 0, stake = ?, outstanding_debt = ?, updated_block = ?
         WHERE circle_id = ? AND account_id = ?`,
      )
      .run(units(e.stake, "stake"), units(e.outstanding_debt, "outstanding_debt"), ctx.block.height, ctx.circleId, e.account_id);
    recordLimit(ctx, { account: e.account_id, epoch: e.epoch, oldLimit, newLimit: 0n, status: "suspended", reason: "default" });
  },

  limits_updated(ctx, e) {
    const update = ctx.db.prepare(
      "UPDATE members SET credit_limit = ?, updated_block = ? WHERE circle_id = ? AND account_id = ?",
    );
    for (const change of e.changes) {
      const newLimit = units(change.new_limit, "new_limit");
      requireChange(update.run(newLimit, ctx.block.height, ctx.circleId, change.account_id).changes, `anggota ${change.account_id}`);
      recordLimit(ctx, {
        account: change.account_id, epoch: e.epoch, oldLimit: units(change.old_limit, "old_limit"), newLimit,
        status: change.status, reason: "finalize",
      });
    }
  },

  epoch_finalized(ctx, e) {
    advancePhase(ctx, e.epoch, "finalized");
    ctx.db
      .prepare("UPDATE epochs SET finalized_at_ns = ? WHERE circle_id = ? AND epoch = ?")
      .run(ns(e.finalized_at, "finalized_at"), ctx.circleId, e.epoch);
  },
};
