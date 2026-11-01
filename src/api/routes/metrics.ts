import { resolveEpoch } from "../epoch-param.js";
import { DECIMALS, UNIT } from "../format.js";
import { computeEpochMetrics } from "../metrics.js";
import type { Route } from "../router.js";
import { derivedPhase } from "./epochs.js";

/** `GET …/epochs/{n}/metrics` (Spec API Backend 5, BE-018). */
export const metricRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/epochs/{n}/metrics",
    circleScoped: true,
    handler: (ctx) => {
      const epoch = resolveEpoch(ctx);
      return {
        status: 200,
        body: {
          circle: ctx.circle.circle_id,
          epoch: Number(epoch.epoch),
          phase: derivedPhase(epoch, BigInt(ctx.now()) * 1_000_000n),
          unit: UNIT,
          decimals: DECIMALS,
          ...computeEpochMetrics(ctx.db, ctx.circle.circle_id, epoch),
        },
      };
    },
  },
];
