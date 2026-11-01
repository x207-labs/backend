import type { HandlerMap } from "./context.js";
import { memberLimit, recordLimit, requireChange } from "./context.js";
import { ns, units } from "../units.js";

/** BE-007: `member_joined`, `stake_added`, `member_admitted`. */
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
};
