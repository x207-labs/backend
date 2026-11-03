import type { HandlerMap } from "./context.js";

/**
 * Interface 0.0.9. \`intent_posted\` puts the hash of an intent in the book of the circle, \`intent_removed\` takes it out (the owner, or anybody when the owner has exited;
 * the event names the owner), and \`intents_withdrawn\` records one withdrawal of the USDT that \`mt_on_transfer\` booked at Intents. A hash can be posted again after it was removed.
 * An intent that was posted before the indexer started is not in the book: its removal is ignored, not a reason to halt.
 */
export const intentHandlers: HandlerMap = {
  intent_posted(ctx, e) {
    ctx.db
      .prepare(
        `INSERT INTO intent_book (circle_id, intent_hash, account_id, status, posted_at_ns, block_height, receipt_id, log_index)
         VALUES (?, ?, ?, 'posted', ?, ?, ?, ?)
         ON CONFLICT (circle_id, intent_hash) DO UPDATE SET status = 'posted', account_id = excluded.account_id, posted_at_ns = excluded.posted_at_ns,
           block_height = excluded.block_height, receipt_id = excluded.receipt_id, log_index = excluded.log_index, removed_block_height = NULL
         WHERE intent_book.status = 'removed'`,
      )
      .run(ctx.circleId, e.intent_hash, e.account_id, BigInt(e.posted_at), ctx.block.height, ctx.receiptId, ctx.logIndex);
  },
  intent_removed(ctx, e) {
    ctx.db
      .prepare("UPDATE intent_book SET status = 'removed', removed_block_height = ? WHERE circle_id = ? AND intent_hash = ? AND status = 'posted'")
      .run(ctx.block.height, ctx.circleId, e.intent_hash);
  },
  intents_withdrawn(ctx, e) {
    ctx.db
      .prepare("INSERT OR IGNORE INTO intent_withdrawals (circle_id, amount, block_height, receipt_id, log_index) VALUES (?, ?, ?, ?, ?)")
      .run(ctx.circleId, BigInt(e.amount), ctx.block.height, ctx.receiptId, ctx.logIndex);
  },
};
