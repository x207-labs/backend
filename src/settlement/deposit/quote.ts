import { randomUUID } from "node:crypto";
import { ApiError, invalidRequest, type ApiErrorCode } from "../../api/errors.js";
import { DECIMALS, isoFromMs, isoFromNs, row, UNIT } from "../../api/format.js";
import type { Route } from "../../api/router.js";
import { SettlementError } from "../errors.js";
import { USDT_NEAR } from "../mock-transport.js";
import { insertJob } from "../jobs.js";
import type { OneClickClient } from "../one-click.js";

const U128_MAX = (1n << 128n) - 1n;

/** Apakah akun NEAR ada (RPC `view_account`); aturan `refundTo` di Spec API Backend 6.1. */
export type AccountExists = (accountId: string) => Promise<boolean>;

/** `view_account` lewat JSON-RPC; "does not exist" berarti tidak ada, error lain dilempar. */
export function nearAccountExists(rpcUrl: string, fetchFn: typeof fetch = fetch): AccountExists {
  return async (accountId) => {
    const response = await fetchFn(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "x207", method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { result?: { error?: string }; error?: { cause?: { name?: string } } };
    // RPC mainnet saat ini menjawab akun yang tidak ada dengan error tingkat atas UNKNOWN_ACCOUNT, bukan `result.error`
    if (body.error?.cause?.name === "UNKNOWN_ACCOUNT") return false;
    if (body.error !== undefined) throw new Error(`RPC view_account gagal: ${JSON.stringify(body.error)}`);
    const error = body.result?.error;
    if (error === undefined) return true;
    if (/does not exist/i.test(error)) return false;
    throw new Error(`RPC view_account: ${error}`);
  };
}

export interface DepositQuoteOptions {
  client: OneClickClient;
  accountExists: AccountExists;
  /** Dipakai untuk ID job; default `randomUUID`. */
  newJobId?: () => string;
}

interface Request {
  purpose: "stake" | "settle";
  circle: string;
  account: string;
  epoch: number | null;
  amount: bigint | null;
  originAsset: string;
  refundType: "INTENTS" | "ORIGIN_CHAIN";
  refundTo: string;
  dry: boolean;
}

function text(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") throw invalidRequest(`${field} wajib berupa string`, { field });
  return value;
}

function parse(raw: unknown): Request {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalidRequest("body harus objek JSON");
  const body = raw as Record<string, unknown>;
  const purpose = body.purpose;
  if (purpose !== "stake" && purpose !== "settle") {
    throw invalidRequest("purpose harus stake atau settle", { purpose, allowed: ["stake", "settle"] });
  }
  const refundType = body.refundType ?? "INTENTS";
  if (refundType !== "INTENTS" && refundType !== "ORIGIN_CHAIN") {
    throw invalidRequest("refundType harus INTENTS atau ORIGIN_CHAIN", { refundType });
  }
  if (body.dry !== undefined && typeof body.dry !== "boolean") throw invalidRequest("dry harus boolean", { dry: body.dry });
  let amount: bigint | null = null;
  let epoch: number | null = null;
  if (purpose === "stake") {
    const raw = body.amount;
    if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw) || BigInt(raw) > U128_MAX) {
      throw invalidRequest("stake butuh amount: string bilangan bulat > 0 dalam satuan terkecil", { amount: raw });
    }
    amount = BigInt(raw);
  } else {
    if (!Number.isSafeInteger(body.epoch) || (body.epoch as number) < 0) {
      throw invalidRequest("settle butuh epoch: bilangan bulat >= 0", { epoch: body.epoch });
    }
    epoch = body.epoch as number;
  }
  return {
    purpose,
    circle: text(body, "circle"),
    account: text(body, "account"),
    epoch,
    amount,
    originAsset: text(body, "originAsset"),
    refundType,
    refundTo: text(body, "refundTo"),
    dry: body.dry !== false,
  };
}

/**
 * `POST /x207/settlement/deposit/quote` (Spec API Backend 6.2, BE-027): quote 1Click `EXACT_OUTPUT` dari aset
 * asal ke USDT NEAR di saldo Intents akun anggota, untuk stake (F1) atau pelunasan `due` (F4).
 */
export function depositQuoteRoutes(options: DepositQuoteOptions): Route[] {
  const { client, accountExists } = options;
  const newJobId = options.newJobId ?? randomUUID;
  return [
    {
      method: "POST",
      pattern: "/x207/settlement/deposit/quote",
      circleScoped: false,
      handler: async ({ db, body, now }) => {
        const req = parse(body);
        if (!row(db, "SELECT 1 AS ok FROM circles WHERE circle_id = ?", req.circle)) {
          throw new ApiError(404, "circle_not_found", `Lingkaran ${req.circle} tidak ada`, { circle: req.circle });
        }
        if (!row(db, "SELECT 1 AS ok FROM members WHERE circle_id = ? AND account_id = ?", req.circle, req.account)) {
          throw new ApiError(404, "member_not_found", `Anggota ${req.account} tidak ada`, { circle: req.circle, account: req.account });
        }

        // `settle`: jumlah dan batas bayar dari D9, `amount` di body diabaikan.
        let amountOut = req.amount;
        let paymentDeadlineNs: bigint | null = null;
        if (req.purpose === "settle") {
          const due = row<{ amount: bigint; due_at_ns: bigint | null }>(
            db,
            "SELECT amount, due_at_ns FROM settlements WHERE circle_id = ? AND epoch = ? AND account_id = ? AND status = 'due'",
            req.circle,
            req.epoch,
            req.account,
          );
          if (!due) {
            throw new ApiError(409, "nothing_due", `${req.account} tidak punya tagihan di epoch ${req.epoch}`, { account: req.account, epoch: req.epoch });
          }
          amountOut = due.amount;
          paymentDeadlineNs = due.due_at_ns;
        }

        // 1Click menolak refund ke akun yang tidak ada dengan error internal, jadi dicek sebelum quote (aturan 6.1).
        if (req.refundType === "INTENTS" && !(await accountExists(req.refundTo))) {
          throw new ApiError(422, "refund_account_not_found", `Akun refundTo ${req.refundTo} tidak ada`, { refundTo: req.refundTo });
        }

        let quote;
        try {
          quote = await client.quote({
            swapType: "EXACT_OUTPUT",
            originAsset: req.originAsset,
            destinationAsset: USDT_NEAR,
            amount: (amountOut as bigint).toString(),
            depositType: "ORIGIN_CHAIN",
            recipientType: "INTENTS",
            refundType: req.refundType,
            refundTo: req.refundTo,
            recipient: req.account,
            dry: req.dry,
          });
        } catch (error) {
          if (error instanceof SettlementError) throw new ApiError(error.status, error.code as ApiErrorCode, error.message, error.details);
          throw error;
        }

        const q = quote.quote as unknown as {
          depositAddress?: string; deadline?: string; amountIn: string; amountOut: string; timeEstimate?: number;
        };
        const nowMs = now();
        const timeEstimate = q.timeEstimate ?? null;
        const warnings: string[] = [];
        if (paymentDeadlineNs !== null && timeEstimate !== null && nowMs + timeEstimate * 1000 > Number(paymentDeadlineNs / 1_000_000n)) {
          warnings.push("deadline_risk");
        }
        const jobId = newJobId();
        const quoteDeadlineMs = q.deadline ? Date.parse(q.deadline) : null;
        insertJob(db, {
          job_id: jobId,
          kind: req.purpose === "stake" ? "deposit_stake" : "deposit_settle",
          circle_id: req.circle,
          account_id: req.account,
          epoch: req.epoch,
          origin_asset: req.originAsset,
          destination_asset: USDT_NEAR,
          amount_in: q.amountIn,
          amount_out: q.amountOut,
          withdraw_fee: null,
          deposit_address: q.depositAddress ?? null,
          refund_to: req.refundTo,
          recipient: req.account,
          recipient_type: "INTENTS",
          dry: req.dry ? 1 : 0,
          status: "waiting_deposit",
          quote_json: JSON.stringify(quote),
          quote_deadline: quoteDeadlineMs,
          created_at: nowMs,
        });

        const msg = req.purpose === "stake" ? '{"action":"stake"}' : `{"action":"settle","epoch":${req.epoch}}`;
        return {
          status: 201,
          body: {
            jobId,
            status: "waiting_deposit",
            dry: req.dry,
            purpose: req.purpose,
            unit: UNIT,
            decimals: DECIMALS,
            originAsset: req.originAsset,
            destinationAsset: USDT_NEAR,
            amountIn: q.amountIn,
            amountOut: q.amountOut,
            recipient: req.account,
            recipientType: "INTENTS",
            depositAddress: q.depositAddress ?? null,
            quoteDeadline: q.deadline ?? (quoteDeadlineMs === null ? null : isoFromMs(quoteDeadlineMs)),
            timeEstimateSeconds: timeEstimate,
            paymentDeadline: isoFromNs(paymentDeadlineNs),
            warnings,
            nextSteps: [
              "kirim amountIn ke depositAddress",
              "tunggu job berstatus ready_withdraw",
              "ft_withdraw dari intents.near ke akun NEAR tanpa msg",
              `ft_transfer_call ke x207-circle dengan msg ${msg}`,
            ],
          },
        };
      },
    },
  ];
}

