import type { HandlerContext, HandlerMap } from "./context.js";
import { advancePhase, ensureEpoch, requireChange } from "./context.js";
import { IndexerHaltError } from "../errors.js";
import { ns, signedUnits, units } from "../units.js";

function epochPhase(ctx: HandlerContext, epoch: number): string | undefined {
  const row = ctx.db.prepare("SELECT phase FROM epochs WHERE circle_id = ? AND epoch = ?").get(ctx.circleId, epoch) as
    | { phase: string }
    | undefined;
  return row?.phase;
}

/** BE-009: `epoch_cutoff`, `clearing_applied`, `epoch_committed`. */
export const epochHandlers: HandlerMap = {
  epoch_cutoff(ctx, e) {
    ensureEpoch(ctx, e.epoch);
    // Fase hanya maju: event berulang untuk epoch yang sudah lewat `open` tidak mengubah apa pun.
    if (epochPhase(ctx, e.epoch) !== "open") return;

    const total = units(e.total_obligation, "total_obligation");
    const agg = ctx.db
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cumulative_amount), 0) AS sum FROM obligations WHERE circle_id = ? AND epoch = ?")
      .safeIntegers(true)
      .get(ctx.circleId, e.epoch) as { n: bigint; sum: bigint };
    if (agg.n !== BigInt(e.edge_count) || agg.sum !== total) {
      throw new IndexerHaltError(
        `epoch_cutoff epoch ${e.epoch}: event ${e.edge_count} edge / ${total}, D9 ${agg.n} edge / ${agg.sum}`,
        true,
      );
    }

    advancePhase(ctx, e.epoch, "clearing");
    ctx.db
      .prepare(
        `UPDATE epochs SET closed_at_ns = ?, proposal_deadline_ns = ?, edge_count = ?, total_obligation = ?
         WHERE circle_id = ? AND epoch = ?`,
      )
      .run(ns(e.closed_at, "closed_at"), ns(e.proposal_deadline, "proposal_deadline"), e.edge_count, total, ctx.circleId, e.epoch);

    ensureEpoch(ctx, e.next_epoch);
    ctx.db
      .prepare("UPDATE epochs SET cutoff_at_ns = ? WHERE circle_id = ? AND epoch = ?")
      .run(ns(e.next_cutoff_at, "next_cutoff_at"), ctx.circleId, e.next_epoch);
    // K-36: anggota yang diaktifkan ulang mulai berlaku saat epoch efektifnya dibuka.
    ctx.db
      .prepare(
        `UPDATE members SET status = 'active', reactivate_epoch = NULL, updated_block = ?
         WHERE circle_id = ? AND status = 'suspended' AND reactivate_epoch IS NOT NULL AND reactivate_epoch <= ?`,
      )
      .run(ctx.block.height, ctx.circleId, e.next_epoch);
  },

  clearing_applied(ctx, e) {
    ensureEpoch(ctx, e.epoch);
    if (e.chunk === 0) {
      // Potongan pertama: semua edge epoch ini dianggap 0, lalu edge yang disebut diisi (ADR-31).
      ctx.db.prepare("UPDATE obligations SET cleared = 0 WHERE circle_id = ? AND epoch = ?").run(ctx.circleId, e.epoch);
      ctx.db
        .prepare(
          `INSERT OR IGNORE INTO clearing_log (circle_id, epoch, solver, cleared_total, fee, edge_count, block_height,
             applied_at_ns, tx_hash, receipt_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        )
        .run(
          ctx.circleId, e.epoch, e.solver ?? "", units(e.cleared_total, "cleared_total"),
          units(e.clearing_fee, "clearing_fee") + units(e.solver_fee, "solver_fee"),
          ctx.block.height, ctx.block.timestampNs, ctx.txHash, ctx.receiptId,
        );
      ctx.db
        .prepare("UPDATE epochs SET cleared_total = ? WHERE circle_id = ? AND epoch = ?")
        .run(units(e.cleared_total, "cleared_total"), ctx.circleId, e.epoch);
    }
    const set = ctx.db.prepare(
      "UPDATE obligations SET cleared = ? WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?",
    );
    for (const edge of e.edges) {
      const result = set.run(units(edge.cleared, "cleared"), ctx.circleId, e.epoch, edge.debtor, edge.creditor);
      requireChange(result.changes, `edge ${edge.debtor} -> ${edge.creditor} epoch ${e.epoch}`);
    }
    ctx.db
      .prepare("UPDATE clearing_log SET edge_count = edge_count + ? WHERE circle_id = ? AND epoch = ?")
      .run(e.edges.length, ctx.circleId, e.epoch);
  },

  epoch_committed(ctx, e) {
    ensureEpoch(ctx, e.epoch);
    const deadline = ns(e.payment_deadline, "payment_deadline");
    if (e.chunk === 0) {
      advancePhase(ctx, e.epoch, "payment_window");
      ctx.db
        .prepare("UPDATE epochs SET committed_at_ns = ?, payment_deadline_ns = ? WHERE circle_id = ? AND epoch = ?")
        .run(ns(e.committed_at, "committed_at"), deadline, ctx.circleId, e.epoch);
    }
    const insert = ctx.db.prepare(
      `INSERT OR IGNORE INTO settlements (circle_id, epoch, account_id, role, net, amount, cleared, status, due_at_ns, updated_block)
       VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(SUM(cleared), 0) FROM obligations WHERE circle_id = ? AND epoch = ? AND creditor = ?), ?, ?, ?)`,
    );
    const debt = ctx.db.prepare(
      "UPDATE members SET outstanding_debt = ?, updated_block = ? WHERE circle_id = ? AND account_id = ?",
    );
    for (const p of e.positions) {
      insert.run(
        ctx.circleId, e.epoch, p.account_id, p.role, signedUnits(p.net, "net"), units(p.amount, "amount"),
        ctx.circleId, e.epoch, p.account_id, p.status, p.role === "debtor" ? deadline : null, ctx.block.height,
      );
      requireChange(debt.run(units(p.outstanding_debt, "outstanding_debt"), ctx.block.height, ctx.circleId, p.account_id).changes, `anggota ${p.account_id}`);
    }
  },
};
