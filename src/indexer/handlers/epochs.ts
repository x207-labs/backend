import type { HandlerContext, HandlerMap } from "./context.js";
import { advancePhase, ensureEpoch, requireChange } from "./context.js";
import { IndexerHaltError } from "../errors.js";
import { ns, signedUnits, units } from "../units.js";
import { storedClearingEdges } from "../clearing-edges.js";
import { clearingHashes } from "../clearing-hashes.js";

/** Interface 0.0.13 (BE-077): `clearing_applied` is a summary; the edges come from `clearing_edges` (read from `list_obligations` and checked against `edges_hash`). */
export interface ClearingAppliedSummary {
  epoch: number;
  solver?: string;
  cleared_total: string;
  edge_count: number;
  edges_hash: string;
  clearing_fee: string;
  solver_fee: string;
}

/** Interface 0.0.13: `epoch_committed` has the whole list of positions (at most 64 members) in one event; `positions_hash` covers it. */
export interface EpochCommittedSummary {
  epoch: number;
  committed_at: string;
  payment_deadline: string;
  total_due: string;
  total_claimable: string;
  position_count: number;
  positions_hash: string;
  positions: Array<{ account_id: string; role: string; net: string; amount: string; status: string | null; outstanding_debt: string }>;
}

const isSummary = (e: unknown): boolean => typeof (e as { edges_hash?: unknown }).edges_hash === "string";
const isPositionsSummary = (e: unknown): boolean => typeof (e as { positions_hash?: unknown }).positions_hash === "string";

function applyClearingSummary(ctx: HandlerContext, e: ClearingAppliedSummary): void {
  ensureEpoch(ctx, e.epoch);
  const stored = storedClearingEdges(ctx.db, ctx.circleId, e.epoch);
  if (!stored || stored.edgesHash !== e.edges_hash) {
    throw new IndexerHaltError(`clearing_applied epoch ${e.epoch}: the edges read from list_obligations are missing or are not the ones of edges_hash ${e.edges_hash}`);
  }
  if (stored.edges.length !== e.edge_count) throw new IndexerHaltError(`clearing_applied epoch ${e.epoch}: event ${e.edge_count} edges, read ${stored.edges.length}`);
  const total = units(e.cleared_total, "cleared_total");
  const sum = stored.edges.reduce((acc, edge) => acc + units(edge.cleared, "cleared"), 0n);
  if (sum !== total) throw new IndexerHaltError(`clearing_applied epoch ${e.epoch}: cleared_total ${total}, the edges add up to ${sum}`);
  // ADR-31: every edge of the epoch is 0, then the ones that were cleared are set
  ctx.db.prepare("UPDATE obligations SET cleared = 0 WHERE circle_id = ? AND epoch = ?").run(ctx.circleId, e.epoch);
  const set = ctx.db.prepare("UPDATE obligations SET cleared = ? WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?");
  for (const edge of stored.edges) requireChange(set.run(units(edge.cleared, "cleared"), ctx.circleId, e.epoch, edge.debtor, edge.creditor).changes, `edge ${edge.debtor} -> ${edge.creditor} epoch ${e.epoch}`);
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO clearing_log (circle_id, epoch, solver, cleared_total, fee, edge_count, block_height, applied_at_ns, tx_hash, receipt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ctx.circleId, e.epoch, e.solver ?? "", total, units(e.clearing_fee, "clearing_fee") + units(e.solver_fee, "solver_fee"), e.edge_count,
      ctx.block.height, ctx.block.timestampNs, ctx.txHash, ctx.receiptId,
    );
  ctx.db.prepare("UPDATE epochs SET cleared_total = ? WHERE circle_id = ? AND epoch = ?").run(total, ctx.circleId, e.epoch);
}

function applyCommittedSummary(ctx: HandlerContext, e: EpochCommittedSummary): void {
  ensureEpoch(ctx, e.epoch);
  if (e.positions.length !== e.position_count) throw new IndexerHaltError(`epoch_committed epoch ${e.epoch}: position_count ${e.position_count}, the event has ${e.positions.length}`);
  const hash = clearingHashes().positionsHash(e.positions);
  if (hash !== e.positions_hash) throw new IndexerHaltError(`epoch_committed epoch ${e.epoch}: positions_hash ${e.positions_hash} is not the hash of the positions of the event (${hash})`);
  const deadline = ns(e.payment_deadline, "payment_deadline");
  advancePhase(ctx, e.epoch, "payment_window");
  ctx.db
    .prepare("UPDATE epochs SET committed_at_ns = ?, payment_deadline_ns = ? WHERE circle_id = ? AND epoch = ?")
    .run(ns(e.committed_at, "committed_at"), deadline, ctx.circleId, e.epoch);
  insertPositions(ctx, e.epoch, deadline, e.positions);
}

function insertPositions(ctx: HandlerContext, epoch: number, deadline: bigint, list: EpochCommittedSummary["positions"]): void {
  const insert = ctx.db.prepare(
    `INSERT OR IGNORE INTO settlements (circle_id, epoch, account_id, role, net, amount, cleared, status, due_at_ns, updated_block)
     VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(SUM(cleared), 0) FROM obligations WHERE circle_id = ? AND epoch = ? AND creditor = ?), ?, ?, ?)`,
  );
  const debt = ctx.db.prepare("UPDATE members SET outstanding_debt = ?, updated_block = ? WHERE circle_id = ? AND account_id = ?");
  for (const p of list) {
    insert.run(
      ctx.circleId, epoch, p.account_id, p.role, signedUnits(p.net, "net"), units(p.amount, "amount"),
      ctx.circleId, epoch, p.account_id, p.status, p.role === "debtor" ? deadline : null, ctx.block.height,
    );
    requireChange(debt.run(units(p.outstanding_debt, "outstanding_debt"), ctx.block.height, ctx.circleId, p.account_id).changes, `member ${p.account_id}`);
  }
}

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
    if (isSummary(e)) return applyClearingSummary(ctx, e as unknown as ClearingAppliedSummary);
    // interface 0.0.12: the edges come in the event, in chunks
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
    if (isPositionsSummary(e)) return applyCommittedSummary(ctx, e as unknown as EpochCommittedSummary);
    // interface 0.0.12: the positions come in chunks
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
      requireChange(debt.run(units(p.outstanding_debt, "outstanding_debt"), ctx.block.height, ctx.circleId, p.account_id).changes, `member ${p.account_id}`);
    }
  },
};
