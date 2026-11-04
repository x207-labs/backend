import { resolveEpoch } from "../epoch-param.js";
import { ApiError, invalidRequest } from "../errors.js";
import { amount, DECIMALS, rows, UNIT } from "../format.js";
import type { Route } from "../router.js";
import { derivedPhase } from "./epochs.js";

const STAGES = ["cutoff", "live", "cleared"] as const;
type Stage = (typeof STAGES)[number];

/** D9 phases that may be read per `stage` (Spec Skema D9 6.3). */
const STAGE_PHASES: Record<Stage, readonly string[] | null> = {
  live: null,
  cutoff: ["clearing", "payment_window", "finalized"],
  cleared: ["payment_window", "finalized"],
};

interface EdgeRow {
  debtor: string;
  creditor: string;
  amount: bigint;
  seq: bigint;
  cleared: bigint | null;
  remaining: bigint;
}

/** `GET …/epochs/{n}/obligations` (Spec API Backend 3.3, BE-015): obligation edges for the solver and the dashboard. */
export const obligationRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/epochs/{n}/obligations",
    circleScoped: true,
    handler: (ctx) => {
      const { db, circle, query, now } = ctx;
      const stage = query.get("stage") ?? "cutoff";
      if (!(STAGES as readonly string[]).includes(stage)) {
        throw invalidRequest("unknown stage", { stage, allowed: STAGES });
      }
      const epoch = resolveEpoch(ctx);
      const allowed = STAGE_PHASES[stage as Stage];
      if (stage === "cutoff" && epoch.phase === "open") {
        throw new ApiError(409, "epoch_not_closed", `Epoch ${epoch.epoch} is not closed yet (cutoff)`, {
          circle: circle.circle_id,
          epoch: Number(epoch.epoch),
          phase: epoch.phase,
        });
      }
      const edges =
        allowed !== null && !allowed.includes(epoch.phase)
          ? []
          : rows<EdgeRow>(
              db,
              `SELECT debtor, creditor, cumulative_amount AS amount, seq, cleared,
                      cumulative_amount - COALESCE(cleared, 0) AS remaining
               FROM obligations WHERE circle_id = ? AND epoch = ? ORDER BY debtor, creditor`,
              circle.circle_id,
              epoch.epoch,
            );
      const total = edges.reduce((sum, e) => sum + e.amount, 0n);
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          epoch: Number(epoch.epoch),
          phase: derivedPhase(epoch, BigInt(now()) * 1_000_000n),
          stage,
          unit: UNIT,
          decimals: DECIMALS,
          edgeCount: edges.length,
          totalObligation: amount(total),
          edges: edges.map((e) => ({
            debtor: e.debtor,
            creditor: e.creditor,
            amount: amount(e.amount),
            seq: Number(e.seq),
            cleared: e.cleared === null ? null : amount(e.cleared),
            remaining: amount(e.remaining),
          })),
        },
      };
    },
  },
];
