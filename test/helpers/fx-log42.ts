import type { BlockLog, BlockSource, SourceBlock } from "../../src/indexer/block-source.js";

export const CONTRACT = "x207-circle.near";
export const acct = (name: string): string => `${name}.x207-circle.near`;
export const AGENTS = ["translator", "summarizer", "image", "scraper", "cleaner", "gpu"] as const;
export const nsOf = (iso: string): string => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

export const DEFAULT_PARAMS = {
  epoch_length: 3600, payment_window: 1800, proposal_window: 600, base_limit_ratio: 8000, limit_growth: 1000,
  limit_cap: "1000000000", limit_decay: 500, fees: { clearing_fee_bps: 0, solver_fee_bps: 0 }, admission: "open",
};

export function eventLog(event: string, data: unknown, version = "0.0.1"): string {
  return `EVENT_JSON:${JSON.stringify({ standard: "x207", version, event, data: [data] })}`;
}

let receiptSeq = 0;
/** Receipt ids are lexicographically ordered so the fixture order matches the replay order. */
export const receiptId = (): string => `r${String(++receiptSeq).padStart(6, "0")}`;

export function block(height: number, ...receipts: { id?: string; logs: string[]; txHash?: string | null }[]): SourceBlock {
  const logs: BlockLog[] = [];
  for (const r of receipts) {
    const id = r.id ?? receiptId();
    r.logs.forEach((log, logIndex) => logs.push({ receiptId: id, logIndex, executorId: CONTRACT, txHash: r.txHash ?? `tx-${id}`, log }));
  }
  return { height, hash: `hash-${height}`, timestampNs: BigInt(height) * 1_000_000_000n, logs };
}

const EDGES = [
  { n: 1, debtor: "translator", creditor: "summarizer", amount: 30_000_000, seq: 12, cleared: 30_000_000 },
  { n: 2, debtor: "summarizer", creditor: "image", amount: 30_000_000, seq: 8, cleared: 30_000_000 },
  { n: 3, debtor: "image", creditor: "translator", amount: 30_000_000, seq: 10, cleared: 30_000_000 },
  { n: 4, debtor: "scraper", creditor: "gpu", amount: 50_000_000, seq: 20, cleared: 15_000_000 },
  { n: 5, debtor: "gpu", creditor: "cleaner", amount: 20_000_000, seq: 5, cleared: 20_000_000 },
  { n: 6, debtor: "cleaner", creditor: "scraper", amount: 15_000_000, seq: 3, cleared: 15_000_000 },
  { n: 7, debtor: "cleaner", creditor: "gpu", amount: 15_000_000, seq: 2, cleared: 5_000_000 },
] as const;
export { EDGES };

/** Running debt of the payer after each edge registration (order L13..L19). */
const DEBT_AFTER = [30_000_000, 30_000_000, 30_000_000, 50_000_000, 20_000_000, 15_000_000, 30_000_000];

export const joinLog = (name: string): string =>
  eventLog("member_joined", {
    account_id: acct(name), pubkey_voucher: `ed25519:${name}`, terms_hash: `terms-${name}`, status: "pending",
    joined_at: nsOf("2026-11-09T08:00:00Z"),
  });
export const stakeLog = (name: string, amount = "100000000", stake = amount, limit = "80000000", status = "active"): string =>
  eventLog("stake_added", { account_id: acct(name), sender_id: acct(name), amount, stake, limit, status });
export const voucherLog = (i: number, over: Record<string, unknown> = {}): string => {
  const e = EDGES[i]!;
  return eventLog("voucher_registered", {
    payer: acct(e.debtor), payee: acct(e.creditor), epoch: 42, seq: e.seq, cumulative_amount: String(e.amount),
    delta: String(e.amount), obligation: String(e.amount), outstanding_debt: String(DEBT_AFTER[i]), mode: "cumulative", ...over,
  });
};
export const cutoffLog = (over: Record<string, unknown> = {}): string =>
  eventLog("epoch_cutoff", {
    epoch: 42, closed_at: nsOf("2026-11-09T11:19:56Z"), proposal_deadline: nsOf("2026-11-09T11:29:56Z"), edge_count: 7,
    participant_count: 6, total_obligation: "190000000", next_epoch: 43, next_cutoff_at: nsOf("2026-11-09T12:19:56Z"), ...over,
  });
export const appliedLog = (edges = EDGES.map((e) => e.n), over: Record<string, unknown> = {}): string =>
  eventLog("clearing_applied", {
    epoch: 42, solver: "solver-b", cleared_total: "145000000",
    edges: EDGES.filter((e) => edges.includes(e.n)).map((e) => ({ debtor: acct(e.debtor), creditor: acct(e.creditor), cleared: String(e.cleared) })),
    clearing_fee: "0", solver_fee: "0", chunk: 0, chunks: 1, ...over,
  });
export function positions(debtOverride: Record<string, string> = {}): Record<string, unknown>[] {
  const none = (name: string): Record<string, unknown> => ({
    account_id: acct(name), net: "0", role: "none", status: null, amount: "0", outstanding_debt: debtOverride[name] ?? "0",
  });
  return [
    { account_id: acct("scraper"), net: "-35000000", role: "debtor", status: "due", amount: "35000000", outstanding_debt: "35000000" },
    { account_id: acct("cleaner"), net: "-10000000", role: "debtor", status: "due", amount: "10000000", outstanding_debt: "10000000" },
    { account_id: acct("gpu"), net: "45000000", role: "creditor", status: "claimable", amount: "45000000", outstanding_debt: "0" },
    none("translator"), none("summarizer"), none("image"),
  ];
}
export const committedLog = (over: Record<string, unknown> = {}): string =>
  eventLog("epoch_committed", {
    epoch: 42, committed_at: nsOf("2026-11-09T11:30:00Z"), payment_deadline: nsOf("2026-11-09T12:00:00Z"),
    total_due: "45000000", total_claimable: "45000000", positions: positions(), chunk: 0, chunks: 1, ...over,
  });
export const paidLog = (): string =>
  eventLog("residual_paid", { epoch: 42, account_id: acct("cleaner"), sender_id: acct("cleaner"), amount: "10000000", refunded: "0", settled_history: "10000000" });
export const defaultedLog = (name = "scraper"): string =>
  eventLog("member_defaulted", {
    epoch: 42, account_id: acct(name), due: "35000000", from_stake: "35000000", from_reserve: "0", shortfall: "0",
    stake: "65000000", status: "suspended", position_status: "defaulted", outstanding_debt: "0",
  });
export const limitsLog = (): string =>
  eventLog("limits_updated", { epoch: 42, changes: [{ account_id: acct("cleaner"), old_limit: "80000000", new_limit: "81000000", status: "active" }], chunk: 0, chunks: 1 });
export const finalizedLog = (): string =>
  eventLog("epoch_finalized", { epoch: 42, finalized_at: nsOf("2026-11-09T12:00:30Z"), defaulted_count: 1, total_defaulted: "35000000", pool: "45000000", shortfall: "0" });
export const claimedLog = (amount = "45000000"): string =>
  eventLog("residual_claimed", { epoch: 42, account_id: acct("gpu"), amount, destination: "intents", status: "claimed" });
export const claimFailedLog = (amount = "45000000", destination = "near"): string =>
  eventLog("residual_claim_failed", { epoch: 42, account_id: acct("gpu"), amount, destination, status: "claimable" });
export const paramsUpdatedLog = (): string =>
  eventLog("params_updated", {
    old: DEFAULT_PARAMS, new: { ...DEFAULT_PARAMS, payment_window: 2700 }, changed: ["payment_window"], effective_epoch: 43,
  });
export const submittedLog = (solver: string, total: string, edges: number, replaced: [string, string] | null): string =>
  eventLog("clearing_submitted", {
    epoch: 42, solver, cleared_total: total, edge_count: edges, replaced_solver: replaced?.[0] ?? null, replaced_cleared_total: replaced?.[1] ?? null,
  });

/** Blocks 1000..1010 for scenario `FX-LOG42` (L01..L30); each block follows the contract's receipt grouping. */
export function fxLog42(first = 1000): SourceBlock[] {
  let h = first;
  return [
    block(h++, ...AGENTS.map((n) => ({ logs: [joinLog(n)] }))),
    block(h++, ...AGENTS.map((n) => ({ logs: [stakeLog(n)] }))),
    block(h++, ...EDGES.map((_, i) => ({ logs: [voucherLog(i)] }))),
    block(h++, { logs: [paramsUpdatedLog()] }),
    block(h++, { logs: [cutoffLog()] }),
    block(h++, { logs: [submittedLog("solver-a", "120000000", 5, null)] }),
    block(h++, { logs: [submittedLog("solver-b", "145000000", 7, ["solver-a", "120000000"])] }),
    block(h++, { logs: [appliedLog(), committedLog()] }),
    block(h++, { logs: [paidLog()] }),
    block(h++, { logs: [defaultedLog(), limitsLog(), finalizedLog()] }),
    block(h++, { logs: [claimedLog()] }),
  ];
}

export class ArrayBlockSource implements BlockSource {
  endpoint = "mock://primary";
  head: number;
  readonly requested: number[] = [];
  headCalls = 0;
  constructor(readonly blocks: SourceBlock[], head?: number) {
    this.head = head ?? Math.max(...blocks.map((b) => b.height));
  }
  finalHeight(): Promise<number> {
    this.headCalls += 1;
    return Promise.resolve(this.head);
  }
  getBlock(height: number): Promise<SourceBlock | null> {
    this.requested.push(height);
    return Promise.resolve(this.blocks.find((b) => b.height === height) ?? null);
  }
}
