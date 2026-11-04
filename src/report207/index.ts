import { resolveEpoch } from "../api/epoch-param.js";
import { amount, DECIMALS, isoFromNs, rows, UNIT } from "../api/format.js";
import { ratio4 } from "../api/metrics.js";
import type { Route } from "../api/router.js";
import { derivedPhase } from "../api/routes/epochs.js";

/** Status per member from D5 (Spec API Backend 4.2, ADR-26). */
export type MemberStatus = 200 | 402 | 202 | 409;

const STATUS_OF: Record<string, MemberStatus> = { due: 402, claimable: 202, defaulted: 409, paid: 200, claimed: 200 };

/** `NULL` (net 0), `paid`, `claimed` → 200; `due` → 402; `claimable` → 202; `defaulted` → 409. */
export function memberStatus(settlement: string | null): MemberStatus {
  return settlement === null ? 200 : (STATUS_OF[settlement] as MemberStatus);
}

/** Signed net position: `+45000000`, `-35000000`, `0`. */
export function formatNet(net: bigint): string {
  return net > 0n ? `+${net}` : net.toString();
}

interface SettlementRow {
  account_id: string;
  net: bigint;
  amount: bigint;
  cleared: bigint;
  status: string | null;
  due_at_ns: bigint | null;
  stake_slashed: bigint;
  haircut: bigint;
}

function member(r: SettlementRow, finalized: boolean) {
  const status = memberStatus(r.status);
  const base = { account: r.account_id, status, net: formatNet(r.net), cleared: amount(r.cleared), settlement: r.status };
  switch (status) {
    case 402:
      return { ...base, amount: amount(r.amount), due: isoFromNs(r.due_at_ns), haircut: amount(r.haircut) };
    case 202:
      // `claim` is allowed only after `finalize_epoch` (ADR-24).
      return { ...base, amount: amount(r.amount), claimable: finalized, haircut: amount(r.haircut) };
    case 409:
      return { ...base, amount: amount(r.amount), stakeSlashed: amount(r.stake_slashed), haircut: amount(r.haircut) };
    default:
      return { ...base, haircut: amount(r.haircut) };
  }
}

/**
 * `GET /x207/circles/{circle}/epochs/{n}`: clearing report `207 Multi-Status` (Spec API Backend 4, BE-020).
 * An epoch that has not been through `commit_epoch` is answered 200 with `committed: false` and `members: []`.
 */
export const reportRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/epochs/{n}",
    circleScoped: true,
    handler: (ctx) => {
      const { db, circle, now } = ctx;
      const epoch = resolveEpoch(ctx);
      const committed = epoch.phase === "payment_window" || epoch.phase === "finalized";
      const finalized = epoch.phase === "finalized";
      const total = epoch.total_obligation ?? 0n;
      const header = {
        circle: circle.circle_id,
        network: circle.network,
        epoch: Number(epoch.epoch),
        phase: derivedPhase(epoch, BigInt(now()) * 1_000_000n),
        committed,
        finalized,
        unit: UNIT,
        decimals: DECIMALS,
        totalObligation: amount(total),
        cleared: amount(epoch.cleared_total),
        clearedRatio: ratio4(epoch.cleared_total, total),
        committedAt: isoFromNs(epoch.committed_at_ns),
        paymentDeadline: isoFromNs(epoch.payment_deadline_ns),
      };
      if (!committed) return { status: 200, body: { ...header, members: [] } };
      const found = rows<SettlementRow>(
        db,
        `SELECT account_id, net, amount, cleared, status, due_at_ns, stake_slashed, haircut
         FROM settlements WHERE circle_id = ? AND epoch = ? ORDER BY account_id`,
        circle.circle_id,
        epoch.epoch,
      );
      return { status: 207, body: { ...header, members: found.map((r) => member(r, finalized)) } };
    },
  },
];
