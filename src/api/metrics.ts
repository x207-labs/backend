import type Database from "better-sqlite3";
import { amount, row } from "./format.js";
import type { EpochRow } from "./routes/epochs.js";

export interface EpochMetrics {
  totalVoucherValue: string;
  cleared: string | null;
  clearedRatio: number | null;
  voucherCount: number;
  residualTransfers: number | null;
  transferSavings: number | null;
  debtBefore: string;
  debtAfter: string | null;
  debtReduction: number | null;
  netDebt: string | null;
  defaultRate: number | null;
  clearingTimeSeconds: number | null;
  graph: { participants: number; edges: number; density: number | null };
}

/** a ÷ b dengan 4 angka di belakang koma (pembulatan setengah ke atas); `null` bila pembagi nol (K-38). */
export function ratio4(a: bigint, b: bigint): number | null {
  if (b === 0n) return null;
  return Number((a * 20_000n + b) / (2n * b)) / 10_000;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Metrik epoch (Spec API Backend 5, BE-018). Sebelum `commit_epoch`, hanya `totalVoucherValue`, `voucherCount`,
 * `debtBefore`, dan `graph` yang terisi (dihitung dari kewajiban terdaftar sejauh ini); sisanya `null`.
 */
export function computeEpochMetrics(db: Database.Database, circleId: string, epoch: EpochRow): EpochMetrics {
  const o = row<{ total: bigint; vouchers: bigint; edges: bigint; after: bigint }>(
    db,
    `SELECT COALESCE(SUM(cumulative_amount), 0) AS total, COALESCE(SUM(seq), 0) AS vouchers, COUNT(*) AS edges,
            COALESCE(SUM(cumulative_amount - COALESCE(cleared, 0)), 0) AS after
     FROM obligations WHERE circle_id = ? AND epoch = ?`,
    circleId, epoch.epoch,
  ) ?? { total: 0n, vouchers: 0n, edges: 0n, after: 0n };
  const participants =
    row<{ n: bigint }>(
      db,
      `SELECT COUNT(*) AS n FROM (SELECT debtor AS a FROM obligations WHERE circle_id = ? AND epoch = ?
         UNION SELECT creditor FROM obligations WHERE circle_id = ? AND epoch = ?)`,
      circleId, epoch.epoch, circleId, epoch.epoch,
    )?.n ?? 0n;

  const p = Number(participants);
  const edges = Number(o.edges);
  const graph = { participants: p, edges, density: p < 2 ? null : round4(edges / (p * (p - 1))) };
  const base = { totalVoucherValue: amount(o.total), voucherCount: Number(o.vouchers), debtBefore: amount(o.total), graph };

  const committed = epoch.phase === "payment_window" || epoch.phase === "finalized";
  if (!committed) {
    return {
      ...base, cleared: null, clearedRatio: null, residualTransfers: null, transferSavings: null, debtAfter: null,
      debtReduction: null, netDebt: null, defaultRate: null, clearingTimeSeconds: null,
    };
  }

  const s = row<{ transfers: bigint; residual: bigint; defaulted: bigint }>(
    db,
    `SELECT COALESCE(SUM(CASE WHEN net <> 0 THEN 1 ELSE 0 END), 0) AS transfers,
            COALESCE(SUM(CASE WHEN role = 'debtor' THEN amount ELSE 0 END), 0) AS residual,
            COALESCE(SUM(CASE WHEN status = 'defaulted' THEN amount ELSE 0 END), 0) AS defaulted
     FROM settlements WHERE circle_id = ? AND epoch = ?`,
    circleId, epoch.epoch,
  ) ?? { transfers: 0n, residual: 0n, defaulted: 0n };
  const reduction = ratio4(o.after, o.total);
  const savings = s.transfers === 0n ? null : round4(Number(o.vouchers) / Number(s.transfers));
  const seconds =
    epoch.committed_at_ns !== null && epoch.closed_at_ns !== null
      ? Number((epoch.committed_at_ns - epoch.closed_at_ns) / 1_000_000n) / 1000
      : null;
  return {
    ...base,
    cleared: amount(epoch.cleared_total),
    clearedRatio: ratio4(epoch.cleared_total, o.total),
    residualTransfers: Number(s.transfers),
    transferSavings: savings,
    debtAfter: amount(o.after),
    debtReduction: reduction === null ? null : round4(1 - reduction),
    netDebt: amount(s.residual),
    // Nilai default ÷ total residual; baru bermakna setelah `finalize_epoch` (BE-019).
    defaultRate: epoch.phase === "finalized" ? ratio4(s.defaulted, s.residual) : null,
    clearingTimeSeconds: seconds,
  };
}
