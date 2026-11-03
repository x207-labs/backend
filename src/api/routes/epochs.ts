import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import { invalidRequest } from "../errors.js";
import { amount, DECIMALS, isoFromNs, rows, UNIT } from "../format.js";
import type { Route } from "../router.js";

export interface EpochRow {
  epoch: bigint;
  phase: "open" | "clearing" | "payment_window" | "finalized";
  cutoff_at_ns: bigint | null;
  closed_at_ns: bigint | null;
  proposal_deadline_ns: bigint | null;
  committed_at_ns: bigint | null;
  payment_deadline_ns: bigint | null;
  finalized_at_ns: bigint | null;
  edge_count: bigint | null;
  total_obligation: bigint | null;
  cleared_total: bigint;
}

/**
 * D9 menyimpan empat fase. `cutoff` (open lewat `cutoff_at`) dan `commit` (clearing lewat
 * `proposal_deadline`) diturunkan dari waktu saat dibaca (Spec Skema D9 3.4, K-41).
 */
export function derivedPhase(e: EpochRow, nowNs: bigint): string {
  if (e.phase === "open" && e.cutoff_at_ns !== null && nowNs >= e.cutoff_at_ns) return "cutoff";
  if (e.phase === "clearing" && e.proposal_deadline_ns !== null && nowNs >= e.proposal_deadline_ns) return "commit";
  return e.phase;
}

export const epochRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/epochs",
    circleScoped: true,
    handler: ({ db, circle, query, now }) => {
      const limit = parseLimit(query);
      const cursor = decodeCursor(query);
      const before = cursor && typeof cursor.e === "number" && Number.isInteger(cursor.e) ? cursor.e : null;
      if (cursor && before === null) throw invalidRequest("invalid cursor");

      const nowNs = BigInt(now()) * 1_000_000n;
      const found = rows<EpochRow>(
        db,
        // an open epoch has no edge count or total in the row (they are written by `epoch_cutoff`): the contract shows the live ones in `get_epoch`, so they are counted from the obligations (BE-067)
        `SELECT e.epoch, e.phase, e.cutoff_at_ns, e.closed_at_ns, e.proposal_deadline_ns, e.committed_at_ns,
                e.payment_deadline_ns, e.finalized_at_ns,
                CASE WHEN e.edge_count IS NULL AND e.phase = 'open' AND EXISTS (SELECT 1 FROM obligations o WHERE o.circle_id = e.circle_id AND o.epoch = e.epoch)
                     THEN (SELECT COUNT(*) FROM obligations o WHERE o.circle_id = e.circle_id AND o.epoch = e.epoch) ELSE e.edge_count END AS edge_count,
                CASE WHEN e.total_obligation IS NULL AND e.phase = 'open' AND EXISTS (SELECT 1 FROM obligations o WHERE o.circle_id = e.circle_id AND o.epoch = e.epoch)
                     THEN (SELECT SUM(o.cumulative_amount) FROM obligations o WHERE o.circle_id = e.circle_id AND o.epoch = e.epoch) ELSE e.total_obligation END AS total_obligation,
                e.cleared_total
         FROM epochs e WHERE e.circle_id = ? AND (? IS NULL OR e.epoch < ?)
         ORDER BY e.epoch DESC LIMIT ?`,
        circle.circle_id,
        before,
        before,
        limit + 1,
      );
      const page = found.slice(0, limit);
      const last = page[page.length - 1];
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          unit: UNIT,
          decimals: DECIMALS,
          items: page.map((e) => ({
            epoch: Number(e.epoch),
            phase: derivedPhase(e, nowNs),
            cutoffAt: isoFromNs(e.cutoff_at_ns),
            closedAt: isoFromNs(e.closed_at_ns),
            proposalDeadline: isoFromNs(e.proposal_deadline_ns),
            committedAt: isoFromNs(e.committed_at_ns),
            paymentDeadline: isoFromNs(e.payment_deadline_ns),
            finalizedAt: isoFromNs(e.finalized_at_ns),
            edgeCount: e.edge_count === null ? null : Number(e.edge_count),
            totalObligation: e.total_obligation === null ? null : amount(e.total_obligation),
            cleared: amount(e.cleared_total),
          })),
          nextCursor: found.length > limit && last ? encodeCursor({ e: Number(last.epoch) }) : null,
        },
      };
    },
  },
];
