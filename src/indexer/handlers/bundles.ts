import type { HandlerMap } from "./context.js";

/** BE-036: `bundle_committed` writes the bundle and its legs; `intent_posted` has no read model here (BE-035 keeps the intent book). */
export const bundleHandlers: HandlerMap = {
  bundle_committed(ctx, e) {
    const bundleId = Number(e.bundle_id);
    const inserted = ctx.db
      .prepare(
        `INSERT OR IGNORE INTO bundles (circle_id, bundle_id, terms_hash, epoch, solver, status, block_height, receipt_id, log_index)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      )
      .run(ctx.circleId, bundleId, e.terms_hash, e.epoch, e.solver, ctx.block.height, ctx.receiptId, ctx.logIndex);
    if (inserted.changes === 0) return; // replay of the same event
    const leg = ctx.db.prepare("INSERT INTO bundle_legs (circle_id, bundle_id, leg_index, payer, payee, max_amount) VALUES (?, ?, ?, ?, ?, ?)");
    e.legs.forEach((l, i) => leg.run(ctx.circleId, bundleId, i, l.payer, l.payee, l.max_amount));
  },
};
