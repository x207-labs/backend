import type { HandlerContext, HandlerMap } from "./context.js";
import { advancePhase, ensureEpoch, recordLimit, requireChange } from "./context.js";
import { IndexerHaltError } from "../errors.js";
import { ns, signedUnits, units } from "../units.js";
import { storedClearingEdges } from "../clearing-edges.js";
import { bondLockedOf, computeCharges, feesForEpoch } from "../fee-charges.js";
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

/**
 * BE-081: the stake and the limit after the fee of the commit. The contract charges the debtors inside `commit_epoch` and no event says how much each paid, so the same rule is repeated here
 * (`fee-charges.ts`) over the cleared edges of the epoch. It is applied only when it adds up to the two totals of the event; otherwise nothing changes and the debtors are marked `stale`.
 * `edgesKnown` is false for an epoch whose pairs were pruned: the charge cannot be computed, and the debtors that the indexer knows from the vouchers are marked.
 */
function chargeFees(ctx: HandlerContext, epoch: number, solver: string | null | undefined, clearedTotal: bigint, eventClearing: bigint, eventSolver: bigint, edgesKnown: boolean): void {
  if (solver === null || solver === undefined || solver === "") return; // no solver, no fee (`charge_fees`)
  const fees = feesForEpoch(ctx.db, ctx.circleId, epoch);
  if (fees === null || clearedTotal === 0n || (fees.clearingBps === 0n && fees.solverBps === 0n)) return;
  const stale = (accounts: string[]): void => {
    const mark = ctx.db.prepare("UPDATE members SET stale = 1, fee_mismatches = fee_mismatches + 1, updated_block = ? WHERE circle_id = ? AND account_id = ?");
    for (const a of accounts) mark.run(ctx.block.height, ctx.circleId, a);
  };
  const debtors = (ctx.db.prepare("SELECT DISTINCT debtor FROM obligations WHERE circle_id = ? AND epoch = ? AND (? = 0 OR cleared > 0)").all(ctx.circleId, epoch, edgesKnown ? 1 : 0) as Array<{ debtor: string }>).map((r) => r.debtor);
  if (!edgesKnown) return stale(debtors);
  const edges = (ctx.db.prepare("SELECT debtor, cleared FROM obligations WHERE circle_id = ? AND epoch = ? AND cleared > 0").safeIntegers(true).all(ctx.circleId, epoch) as Array<{ debtor: string; cleared: bigint }>);
  const members = new Map<string, { stake: bigint; limit: bigint }>();
  for (const r of ctx.db.prepare("SELECT account_id, stake, credit_limit FROM members WHERE circle_id = ?").safeIntegers(true).all(ctx.circleId) as Array<{ account_id: string; stake: bigint; credit_limit: bigint }>) {
    members.set(r.account_id, { stake: r.stake, limit: r.credit_limit });
  }
  const result = computeCharges({ edges, clearedTotal, clearingBps: fees.clearingBps, solverBps: fees.solverBps, members, bondLocked: (a) => bondLockedOf(ctx.db, ctx.circleId, a) });
  if (result === null || result.toReserve !== eventClearing || result.toSolver !== eventSolver) return stale(debtors);
  const update = ctx.db.prepare("UPDATE members SET stake = ?, credit_limit = ?, updated_block = ? WHERE circle_id = ? AND account_id = ?");
  for (const c of result.charges) {
    const before = members.get(c.account) as { stake: bigint; limit: bigint };
    update.run(c.stake, c.limit, ctx.block.height, ctx.circleId, c.account);
    if (c.limit !== before.limit) recordLimit(ctx, { account: c.account, epoch, oldLimit: before.limit, newLimit: c.limit, status: "active", reason: "stake" });
  }
}

function applyClearingSummary(ctx: HandlerContext, e: ClearingAppliedSummary): void {
  ensureEpoch(ctx, e.epoch);
  const stored = storedClearingEdges(ctx.db, ctx.circleId, e.epoch);
  if (!stored || stored.edgesHash !== e.edges_hash) {
    throw new IndexerHaltError(`clearing_applied epoch ${e.epoch}: the edges read from list_obligations are missing or are not the ones of edges_hash ${e.edges_hash}`);
  }
  if (stored.unavailable) {
    // B8-F1: the contract no longer has the edges of this epoch (pruned): `obligations.cleared` stays unknown, the summary is recorded, the positions come with `epoch_committed`
    const total = units(e.cleared_total, "cleared_total");
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO clearing_log (circle_id, epoch, solver, cleared_total, fee, edge_count, block_height, applied_at_ns, tx_hash, receipt_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ctx.circleId, e.epoch, e.solver ?? "", total, units(e.clearing_fee, "clearing_fee") + units(e.solver_fee, "solver_fee"), e.edge_count,
        ctx.block.height, ctx.block.timestampNs, ctx.txHash, ctx.receiptId,
      );
    ctx.db.prepare("UPDATE epochs SET cleared_total = ?, edges_unavailable = 1 WHERE circle_id = ? AND epoch = ?").run(total, ctx.circleId, e.epoch);
    chargeFees(ctx, e.epoch, e.solver, total, units(e.clearing_fee, "clearing_fee"), units(e.solver_fee, "solver_fee"), false);
    return;
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
  chargeFees(ctx, e.epoch, e.solver, total, units(e.clearing_fee, "clearing_fee"), units(e.solver_fee, "solver_fee"), true);
}

function applyCommittedSummary(ctx: HandlerContext, e: EpochCommittedSummary): void {
  ensureEpoch(ctx, e.epoch);
  if (e.positions.length !== e.position_count) throw new IndexerHaltError(`epoch_committed epoch ${e.epoch}: position_count ${e.position_count}, the event has ${e.positions.length}`);
  const hash = clearingHashes().positionsHash(e.positions as never);
  if (hash !== e.positions_hash) throw new IndexerHaltError(`epoch_committed epoch ${e.epoch}: positions_hash ${e.positions_hash} is not the hash of the positions of the event (${hash})`);
  // the totals are the sums of the positions: what the debtors owe and what the creditors can claim
  const sumOf = (role: string): bigint => e.positions.filter((p) => p.role === role).reduce((acc, p) => acc + units(p.amount, "amount"), 0n);
  const totalDue = units(e.total_due, "total_due");
  const totalClaimable = units(e.total_claimable, "total_claimable");
  if (sumOf("debtor") !== totalDue) throw new IndexerHaltError(`epoch_committed epoch ${e.epoch}: total_due ${totalDue}, the debtors add up to ${sumOf("debtor")}`);
  if (sumOf("creditor") !== totalClaimable) throw new IndexerHaltError(`epoch_committed epoch ${e.epoch}: total_claimable ${totalClaimable}, the creditors add up to ${sumOf("creditor")}`);
  const deadline = ns(e.payment_deadline, "payment_deadline");
  advancePhase(ctx, e.epoch, "payment_window");
  ctx.db
    .prepare("UPDATE epochs SET committed_at_ns = ?, payment_deadline_ns = ?, total_due = ?, total_claimable = ? WHERE circle_id = ? AND epoch = ?")
    .run(ns(e.committed_at, "committed_at"), deadline, totalDue, totalClaimable, ctx.circleId, e.epoch);
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
    // Phase only moves forward: a repeated event for an epoch already past `open` changes nothing.
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
    // K-36: a reactivated member takes effect when its effective epoch opens.
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
      // First chunk: all edges of this epoch count as 0, then the edges that are named are filled in (ADR-31).
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
    for (const edge of e.edges ?? []) {
      const result = set.run(units(edge.cleared, "cleared"), ctx.circleId, e.epoch, edge.debtor, edge.creditor);
      requireChange(result.changes, `edge ${edge.debtor} -> ${edge.creditor} epoch ${e.epoch}`);
    }
    ctx.db
      .prepare("UPDATE clearing_log SET edge_count = edge_count + ? WHERE circle_id = ? AND epoch = ?")
      .run((e.edges ?? []).length, ctx.circleId, e.epoch);
    // BE-081: the fee comes out of the stake once the last chunk has set `cleared` of every edge
    if (e.chunk === (e.chunks ?? 1) - 1) chargeFees(ctx, e.epoch, e.solver, units(e.cleared_total, "cleared_total"), units(e.clearing_fee, "clearing_fee"), units(e.solver_fee, "solver_fee"), true);
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
