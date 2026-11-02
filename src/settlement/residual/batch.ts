import { SettlementError } from "../errors.js";
import type { SettlementMode } from "../config.js";
import { settleMsg, simulateIntents, USDT_TOKEN_ID, type ViewFunction } from "../intents.js";

// BE-034 (ADR-21 stretch goal, study CT-058): the net debtors of an epoch pay their residual with one Intents `transfer` each, signed
// by the debtor, and one `execute_intents` carries all of them. The Intents balances move all-or-nothing; the circle learns of each
// payment from `mt_on_transfer`, a separate receipt, so the status `paid` is NOT atomic across debtors (CT-058). This module plans the
// transfers, checks the signed payloads, simulates, executes only in `live` mode, and reconciles against the positions of the circle.
// The `mt_on_transfer` method of the circle does not exist yet, so a real run cannot mark anybody `paid`; see docs/residual-batch.md.

/** A debtor with a `due` residual in the payment window of `epoch` (read model D9 / view `net_position`). */
export interface DuePosition {
  account: string;
  /** Base units of the credit (6 decimals). */
  amount: bigint;
}

/** The unsigned `transfer` intent that one debtor signs (Intents NEP-413 payload; the nonce and deadline are made by the signer). */
export interface ResidualTransfer {
  debtor: string;
  amount: string;
  intent: { intent: "transfer"; receiver_id: string; tokens: Record<string, string>; msg: string; min_gas?: string };
}

export interface PlanOptions {
  circleContract: string;
  epoch: number;
  tokenId?: string;
  /** Debtors per `execute_intents`. Each notification takes at least 5 Tgas and defaults to 30 Tgas; the real limit is not measured. */
  maxPerCall?: number;
}

export const DEFAULT_MAX_PER_CALL = 5;

const intentTokenId = (tokenId: string): string => (tokenId.startsWith("nep141:") ? tokenId : `nep141:${tokenId}`);

/** One transfer per debtor, in the order of the account names, grouped in calls of at most `maxPerCall`. Zero amounts are left out. */
export function planResidualBatches(positions: readonly DuePosition[], options: PlanOptions): ResidualTransfer[][] {
  const size = options.maxPerCall ?? DEFAULT_MAX_PER_CALL;
  if (!Number.isInteger(size) || size < 1) throw new RangeError("maxPerCall must be an integer >= 1");
  const transfers = [...positions]
    .filter((p) => p.amount > 0n)
    .sort((a, b) => (a.account < b.account ? -1 : 1))
    .map<ResidualTransfer>((p) => ({
      debtor: p.account,
      amount: p.amount.toString(),
      intent: {
        intent: "transfer",
        receiver_id: options.circleContract,
        tokens: { [intentTokenId(options.tokenId ?? USDT_TOKEN_ID)]: p.amount.toString() },
        msg: settleMsg(options.epoch),
      },
    }));
  const batches: ResidualTransfer[][] = [];
  for (let i = 0; i < transfers.length; i += size) batches.push(transfers.slice(i, i + size));
  return batches;
}

/** A signed payload as the debtor hands it over: opaque to this module except for the signed message. */
export type SignedPayload = { payload?: { message?: string }; [key: string]: unknown };

export type PayloadCheck = { ok: true; debtor: string } | { ok: false; reason: string };

/**
 * The signed `message` must be JSON of the debtor's own transfer: `signer_id` = debtor, `verifying_contract` = the Verifier, and exactly the
 * planned intent (receiver, token, amount, msg). The signature itself is checked by `simulate_intents`, not here. The exact NEP-413
 * wrapper of `MultiPayload` was not verified against a live Verifier; only the fields named here are read.
 */
export function checkSignedPayload(signed: SignedPayload, transfer: ResidualTransfer, verifier: string): PayloadCheck {
  const message = signed.payload?.message;
  if (typeof message !== "string") return { ok: false, reason: "no signed message" };
  let body: { signer_id?: unknown; verifying_contract?: unknown; intents?: unknown };
  try {
    body = JSON.parse(message) as typeof body;
  } catch {
    return { ok: false, reason: "message is not JSON" };
  }
  if (body.signer_id !== transfer.debtor) return { ok: false, reason: `signer_id is not ${transfer.debtor}` };
  if (body.verifying_contract !== verifier) return { ok: false, reason: "verifying_contract is not the Verifier" };
  if (!Array.isArray(body.intents) || body.intents.length !== 1) return { ok: false, reason: "exactly one intent expected" };
  if (JSON.stringify(sortKeys(body.intents[0])) !== JSON.stringify(sortKeys(transfer.intent))) return { ok: false, reason: "the intent is not the planned transfer" };
  return { ok: true, debtor: transfer.debtor };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, sortKeys(v)]));
  return value;
}

export type DebtorOutcome = { debtor: string; status: "paid" | "pending" };

export type BatchResult =
  | { status: "rejected"; problems: Array<{ debtor: string; reason: string }> }
  | { status: "simulation_failed"; message: string }
  | { status: "invariant_violated"; violation: unknown }
  | { status: "dry_run_ok"; debtors: string[]; simulation: unknown }
  | { status: "executed"; debtors: string[]; txHash: string; outcomes: DebtorOutcome[] };

export interface RunOptions {
  mode: SettlementMode;
  verifier: string;
  view: ViewFunction;
  /** Signed payloads by debtor. A debtor of the plan without one is reported as a problem and nothing is sent. */
  signed: ReadonlyMap<string, SignedPayload>;
  /** Sends `execute_intents(signed)` from the relayer and returns the transaction hash. Only called in `live` mode. */
  execute?: (signed: SignedPayload[]) => Promise<string>;
  /** Position of the debtor in the epoch right now, read from the circle or the read model. */
  readStatus?: (debtor: string) => Promise<string>;
  /** Reconciliation tries and the wait between them. */
  attempts?: number;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One `execute_intents` for one batch of the plan. Order: every signed payload matches its planned transfer, `simulate_intents` passes with
 * no invariant violation, then `dry`/`mock` stop with `dry_run_ok`; `live` executes and reconciles each debtor to `paid` or `pending`
 * (a debtor that is still `due` after the tries stays `pending`, never assumed paid). `live` needs a human decision upstream: here it only
 * demands an `execute` function, and the caller refuses `live` without confirmation (`live_mode_disabled`).
 */
export async function runResidualBatch(batch: readonly ResidualTransfer[], options: RunOptions): Promise<BatchResult> {
  const problems: Array<{ debtor: string; reason: string }> = [];
  const signed: SignedPayload[] = [];
  for (const transfer of batch) {
    const payload = options.signed.get(transfer.debtor);
    if (payload === undefined) {
      problems.push({ debtor: transfer.debtor, reason: "no signed payload" });
      continue;
    }
    const checked = checkSignedPayload(payload, transfer, options.verifier);
    if (checked.ok) signed.push(payload);
    else problems.push({ debtor: transfer.debtor, reason: checked.reason });
  }
  if (problems.length > 0) return { status: "rejected", problems };

  const simulation = await simulateIntents(options.view, signed);
  if (!simulation.ok) return { status: "simulation_failed", message: simulation.message };
  const violation = (simulation.result as { invariant_violated?: unknown } | null)?.invariant_violated;
  if (violation !== null && violation !== undefined) return { status: "invariant_violated", violation };

  const debtors = batch.map((t) => t.debtor);
  if (options.mode !== "live") return { status: "dry_run_ok", debtors, simulation: simulation.result };
  if (options.execute === undefined) throw new SettlementError("live_mode_disabled", "live mode needs an execute function and a human confirmation");

  const txHash = await options.execute(signed);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const outcomes: DebtorOutcome[] = debtors.map((debtor) => ({ debtor, status: "pending" }));
  for (let attempt = 0; attempt < (options.attempts ?? 10); attempt += 1) {
    for (const outcome of outcomes) {
      if (outcome.status === "pending" && options.readStatus !== undefined) {
        if ((await options.readStatus(outcome.debtor)) === "paid") outcome.status = "paid";
      }
    }
    if (outcomes.every((o) => o.status === "paid")) break;
    await sleep(options.waitMs ?? 3000);
  }
  return { status: "executed", debtors, txHash, outcomes };
}
