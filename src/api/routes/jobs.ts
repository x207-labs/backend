import { refreshJob } from "../../settlement/deposit/monitor.js";
import { getJob } from "../../settlement/jobs.js";
import { SettlementError } from "../../settlement/errors.js";
import type { OneClickClient } from "../../settlement/one-click.js";
import { ApiError } from "../errors.js";
import { isoFromMs } from "../format.js";
import type { Route } from "../router.js";

/** `GET /x207/settlement/jobs/{jobId}` (Spec API Backend 6.5): memperbarui job dari 1Click lalu menjawab. */
export function jobRoutes(client: OneClickClient): Route[] {
  return [
    {
      method: "GET",
      pattern: "/x207/settlement/jobs/{jobId}",
      circleScoped: false,
      handler: async ({ db, params, now }) => {
        const jobId = params.jobId as string;
        const found = getJob(db, jobId);
        if (!found) throw new ApiError(404, "job_not_found", `Unknown job ${jobId}`, { jobId });
        let job = found;
        try {
          job = await refreshJob({ db, client, now }, found);
        } catch (error) {
          if (error instanceof SettlementError) {
            throw new ApiError(error.status, "one_click_error", error.message, error.details);
          }
          throw error;
        }
        return {
          status: 200,
          body: {
            jobId: job.job_id,
            kind: job.kind,
            status: job.status,
            oneClickStatus: job.one_click_status,
            account: job.account_id,
            epoch: job.epoch,
            depositAddress: job.deposit_address,
            amountOut: job.amount_out,
            intentHash: job.intent_hash,
            updatedAt: isoFromMs(job.updated_at),
          },
        };
      },
    },
  ];
}
