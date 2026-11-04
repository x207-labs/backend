import { randomUUID } from "node:crypto";
import type { IntentStandardEnum, MultiPayload } from "@defuse-protocol/one-click-sdk-typescript";
import { ApiError, invalidRequest, type ApiErrorCode } from "../../api/errors.js";
import { DECIMALS, row, UNIT } from "../../api/format.js";
import type { Route } from "../../api/router.js";
import { SettlementError } from "../errors.js";
import { getJob, insertJob, setJobState } from "../jobs.js";
import { USDT_NEAR } from "../mock-transport.js";
import type { OneClickClient } from "../one-click.js";
import type { AccountExists } from "../deposit/quote.js";
import { evaluateWithdrawThreshold } from "./threshold.js";

const U128_MAX = (1n << 128n) - 1n;
const VARIABLE_FEE_BPS_ESTIMATE = 14;

export interface WithdrawOptions {
  client: OneClickClient;
  /** Check `refundTo` before the quote: 1Click answers with an internal error for a non-existent NEAR account (Spec API Backend 6.1). */
  accountExists: AccountExists;
  /** Used for the job ID; default `randomUUID`. */
  newJobId?: () => string;
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") throw invalidRequest(`${field} must be a string`, { field });
  return value;
}

function objectBody(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalidRequest("body must be a JSON object");
  return raw as Record<string, unknown>;
}

async function oneClick<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof SettlementError) throw new ApiError(error.status, error.code as ApiErrorCode, error.message, error.details);
    throw error;
  }
}

function conflict(jobId: string, status: string, expected: string): ApiError {
  return new ApiError(409, "job_state_conflict", `Job ${jobId} has status ${status}, this step needs ${expected}`, { jobId, status, expected });
}

/**
 * Creditor outbound path (Spec API Backend 6.3, 6.4; BE-030): `POST /x207/settlement/withdraw/quote`, `…/intent`
 * and `…/submit`. The order is quote → intent → submit; a step out of order is rejected with `job_state_conflict`.
 * The worker does not sign: the intent is signed by the creditor's wallet (spec 2.2).
 */
export function withdrawRoutes(options: WithdrawOptions): Route[] {
  const { client, accountExists } = options;
  const newJobId = options.newJobId ?? randomUUID;

  /** `dry` mode talks to the real 1Click: quotes are allowed, but sending a signed intent is not. */
  const assertMayMoveFunds = () => {
    if (client.mode === "dry") throw new ApiError(422, "live_mode_disabled", "submit-intent needs X207_SETTLEMENT_MODE=live", { mode: client.mode });
  };

  return [
    {
      method: "POST",
      pattern: "/x207/settlement/withdraw/quote",
      circleScoped: false,
      handler: async ({ db, body, now }) => {
        const req = objectBody(body);
        const circle = text(req, "circle");
        const account = text(req, "account");
        const destinationAsset = text(req, "destinationAsset");
        const recipient = text(req, "recipient");
        const refundTo = text(req, "refundTo");
        const rawAmount = req.amount;
        if (typeof rawAmount !== "string" || !/^[1-9]\d*$/.test(rawAmount) || BigInt(rawAmount) > U128_MAX) {
          throw invalidRequest("amount must be a string integer > 0 in the smallest unit", { amount: rawAmount });
        }
        if (req.acceptHighFee !== undefined && typeof req.acceptHighFee !== "boolean") throw invalidRequest("acceptHighFee must be a boolean", { acceptHighFee: req.acceptHighFee });
        if (req.dry !== undefined && typeof req.dry !== "boolean") throw invalidRequest("dry must be a boolean", { dry: req.dry });
        const dry = req.dry !== false;
        const acceptHighFee = req.acceptHighFee === true;

        if (!row(db, "SELECT 1 AS ok FROM circles WHERE circle_id = ?", circle)) {
          throw new ApiError(404, "circle_not_found", `Circle ${circle} not found`, { circle });
        }
        if (!row(db, "SELECT 1 AS ok FROM members WHERE circle_id = ? AND account_id = ?", circle, account)) {
          throw new ApiError(404, "member_not_found", `Member ${account} not found`, { circle, account });
        }

        if (!(await accountExists(refundTo))) {
          throw new ApiError(422, "refund_account_not_found", `refundTo account ${refundTo} not found`, { refundTo });
        }

        const quote = await oneClick(() =>
          client.quote({
            swapType: "EXACT_INPUT",
            originAsset: USDT_NEAR,
            destinationAsset,
            amount: rawAmount,
            depositType: "INTENTS",
            recipientType: "DESTINATION_CHAIN",
            refundType: "INTENTS",
            refundTo,
            recipient,
            dry,
          }),
        );
        const q = quote.quote as unknown as { depositAddress?: string; deadline?: string; amountIn: string; amountOut: string; timeEstimate?: number; withdrawFee?: string };
        const withdrawFee = q.withdrawFee ?? "0";

        const verdict = evaluateWithdrawThreshold({ destinationAsset, amount: rawAmount, withdrawFee, amountOut: q.amountOut, acceptHighFee });
        if (!verdict.ok) {
          const { code, message, details } = verdict.error;
          throw new ApiError(422, code, message, details);
        }

        const amountIn = BigInt(q.amountIn);
        const totalFeePct = amountIn === 0n ? 0 : Math.round(Number(((amountIn - BigInt(q.amountOut)) * 10_000_000n) / amountIn) / 10) / 10_000;
        const nowMs = now();
        const jobId = newJobId();
        insertJob(db, {
          job_id: jobId,
          kind: "withdraw",
          circle_id: circle,
          account_id: account,
          epoch: null,
          origin_asset: USDT_NEAR,
          destination_asset: destinationAsset,
          amount_in: q.amountIn,
          amount_out: q.amountOut,
          withdraw_fee: withdrawFee,
          deposit_address: q.depositAddress ?? null,
          refund_to: refundTo,
          recipient,
          recipient_type: "DESTINATION_CHAIN",
          dry: dry ? 1 : 0,
          status: "quoted",
          quote_json: JSON.stringify(quote),
          quote_deadline: q.deadline ? Date.parse(q.deadline) : null,
          created_at: nowMs,
        });
        return {
          status: 201,
          body: {
            jobId,
            status: "quoted",
            dry,
            unit: UNIT,
            decimals: DECIMALS,
            originAsset: USDT_NEAR,
            destinationAsset,
            depositType: "INTENTS",
            recipientType: "DESTINATION_CHAIN",
            amountIn: q.amountIn,
            amountOut: q.amountOut,
            withdrawFee,
            variableFeeBpsEstimate: VARIABLE_FEE_BPS_ESTIMATE,
            totalFeePct,
            threshold: verdict.threshold,
            timeEstimateSeconds: q.timeEstimate ?? null,
            warnings: verdict.warnings.map((w) => w.code),
          },
        };
      },
    },
    {
      method: "POST",
      pattern: "/x207/settlement/withdraw/intent",
      circleScoped: false,
      handler: async ({ db, body, now }) => {
        const jobId = text(objectBody(body), "jobId");
        const job = getJob(db, jobId);
        if (!job) throw new ApiError(404, "job_not_found", `Unknown job ${jobId}`, { jobId });
        // a deposit job and a second intent land here too (K-39)
        if (job.kind !== "withdraw" || job.status !== "quoted") throw conflict(jobId, job.status, "withdraw must be quoted");
        const response = await oneClick(() =>
          client.generateIntent({ depositAddress: job.deposit_address ?? "", signerId: job.account_id, standard: "nep413" as IntentStandardEnum }),
        );
        setJobState(db, jobId, { status: "awaiting_signature", updated_at: now() });
        return { status: 200, body: { jobId, intent: response.intent } };
      },
    },
    {
      method: "POST",
      pattern: "/x207/settlement/withdraw/submit",
      circleScoped: false,
      handler: async ({ db, body, now }) => {
        const req = objectBody(body);
        const jobId = text(req, "jobId");
        const signed = req.signedIntent;
        if (typeof signed !== "object" || signed === null || Array.isArray(signed)) throw invalidRequest("signedIntent must be an object", { field: "signedIntent" });
        const job = getJob(db, jobId);
        if (!job) throw new ApiError(404, "job_not_found", `Unknown job ${jobId}`, { jobId });
        if (job.kind !== "withdraw" || job.status !== "awaiting_signature") throw conflict(jobId, job.status, "withdraw must be awaiting_signature");
        assertMayMoveFunds();
        const response = await oneClick(() => client.submitIntent(signed as MultiPayload));
        setJobState(db, jobId, { status: "processing", intent_hash: response.intentHash, updated_at: now() });
        return { status: 202, body: { jobId, status: "processing", intentHash: response.intentHash } };
      },
    },
  ];
}
