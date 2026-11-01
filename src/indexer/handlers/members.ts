import type { HandlerMap } from "./context.js";
import { memberLimit, recordLimit, requireChange } from "./context.js";
import { ns, units } from "../units.js";

/** BE-007: `member_joined`, `stake_added`, `member_admitted`. BE-039: `exit_requested`, `stake_withdrawn`, `stake_withdraw_failed`, `member_reactivated`. */
export const memberHandlers: HandlerMap = {
  member_joined(ctx, e) {
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO members (circle_id, account_id, pubkey_voucher, terms_hash, stake, credit_limit,
           outstanding_debt, status, admitted, settled_history, joined_at_ns, updated_block)
         VALUES (?, ?, ?, ?, 0, 0, 0, 'pending', 0, 0, ?, ?)`,
      )
      .run(ctx.circleId, e.account_id, e.pubkey_voucher, e.terms_hash, ns(e.joined_at, "joined_at"), ctx.block.height);
  },

  stake_added(ctx, e) {
    const oldLimit = memberLimit(ctx, e.account_id);
    const newLimit = units(e.limit, "limit");
    // Nilai event ditimpa langsung, termasuk status (anggota suspended tetap suspended).
    ctx.db
      .prepare("UPDATE members SET stake = ?, credit_limit = ?, status = ?, updated_block = ? WHERE circle_id = ? AND account_id = ?")
      .run(units(e.stake, "stake"), newLimit, e.status, ctx.block.height, ctx.circleId, e.account_id);
    recordLimit(ctx, { account: e.account_id, epoch: null, oldLimit, newLimit, status: e.status, reason: "stake" });
  },

  member_admitted(ctx, e) {
    const result = ctx.db
      .prepare("UPDATE members SET admitted = 1, updated_block = ? WHERE circle_id = ? AND account_id = ?")
      .run(ctx.block.height, ctx.circleId, e.account_id);
    requireChange(result.changes, `anggota ${e.account_id}`);
  },

  // ADR-29: the status stays until `stake_withdrawn`.
  exit_requested(ctx, e) {
    const result = ctx.db
      .prepare("UPDATE members SET exit_requested_epoch = ?, updated_block = ? WHERE circle_id = ? AND account_id = ?")
      .run(e.epoch, ctx.block.height, ctx.circleId, e.account_id);
    requireChange(result.changes, `anggota ${e.account_id}`);
  },

  stake_withdrawn(ctx, e) {
    const result = ctx.db
      .prepare(
        "UPDATE members SET status = 'exited', stake = 0, credit_limit = 0, updated_block = ? WHERE circle_id = ? AND account_id = ?",
      )
      .run(ctx.block.height, ctx.circleId, e.account_id);
    requireChange(result.changes, `anggota ${e.account_id}`);
  },

  // A failed transfer restores the stake on chain and changes nothing in D9; the raw row is enough.
  stake_withdraw_failed() {},

  // ADR-30 (P1): the status turns `active` when epoch `effective_epoch` opens (K-36, see `epoch_cutoff`).
  member_reactivated(ctx, e) {
    const result = ctx.db
      .prepare(
        `UPDATE members SET stake = ?, credit_limit = ?, settled_history = 0, reactivate_epoch = ?, updated_block = ?
         WHERE circle_id = ? AND account_id = ?`,
      )
      .run(units(e.stake, "stake"), units(e.limit, "limit"), e.effective_epoch, ctx.block.height, ctx.circleId, e.account_id);
    requireChange(result.changes, `anggota ${e.account_id}`);
  },
};
