import type { HandlerMap } from "./context.js";
import { IndexerHaltError } from "../errors.js";

/** BE-012: one history row per name in `changed`; the value is stored as JSON. */
export const paramsHandlers: HandlerMap = {
  params_updated(ctx, e) {
    const insert = ctx.db.prepare(
      `INSERT OR IGNORE INTO params (circle_id, field, old_value, new_value, effective_epoch, block_height, receipt_id, log_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const oldParams = e.old as unknown as Record<string, unknown>;
    const newParams = e.new as unknown as Record<string, unknown>;
    for (const field of e.changed) {
      if (!(field in newParams)) throw new IndexerHaltError(`params_updated: field ${field} is missing from new`);
      insert.run(
        ctx.circleId, field, JSON.stringify(oldParams[field] ?? null), JSON.stringify(newParams[field]),
        e.effective_epoch, ctx.block.height, ctx.receiptId, ctx.logIndex,
      );
    }
  },
};
