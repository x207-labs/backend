// BE-081: the fee that `commit_epoch` takes from the stake of the debtors. The contract does the charge inside `commit_epoch` (`charge_fees`, `pro_rata_fee` of `commit.rs`) and no event says
// how much each member paid: `clearing_applied` has only the two totals, and a log for each member does not fit the 16 KiB of the receipt. So the indexer repeats the rule, with what it has:
//   1. the fee of each kind is `cleared_total * bps / 10000` (floor), the `bps` of `params.fees` in force for the epoch;
//   2. `fee_total` is shared over the debtors pro rata to what they cleared: floor shares, then the leftover units one by one in the order of the account names, and a share of 0 is dropped;
//   3. a debtor pays at most its stake: `take = min(share, stake)`;
//   4. the limit is lowered to the stake minus the locked bond (`bound_limit`).
// The charge is applied only when it adds up to the two totals of the event (`clearing_fee` = what went to the reserve, `solver_fee` = the rest); when it does not, nothing is applied and the
// debtors are marked `stale`. The view `member` is the watch (`verifyMembers` of the indexer, and `scripts/testnet-v013.mjs`).
import type Database from "better-sqlite3";

export interface FeeShare {
  account: string;
  share: bigint;
}

/** `pro_rata_fee` of the contract: floor shares, the leftover one unit at a time in account order, shares of 0 dropped. `edges` are the cleared edges (`cleared > 0`). */
export function proRataFee(edges: ReadonlyArray<{ debtor: string; cleared: bigint }>, clearedTotal: bigint, feeTotal: bigint): FeeShare[] {
  if (feeTotal === 0n || clearedTotal === 0n) return [];
  const byDebtor = new Map<string, bigint>();
  for (const e of edges) byDebtor.set(e.debtor, (byDebtor.get(e.debtor) ?? 0n) + e.cleared);
  // the map of the contract is ordered by the name of the account (a string compared byte by byte)
  const shares: FeeShare[] = [...byDebtor.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([account, cleared]) => ({ account, share: (feeTotal * cleared) / clearedTotal }));
  let leftover = feeTotal - shares.reduce((n, s) => n + s.share, 0n);
  for (const s of shares) {
    if (leftover === 0n) break;
    s.share += 1n;
    leftover -= 1n;
  }
  return shares.filter((s) => s.share > 0n);
}

export interface FeeCharge {
  account: string;
  take: bigint;
  stake: bigint;
  limit: bigint;
}

/** The charge of one commit: who pays what, the new stake and the new limit of each, and the two totals as the contract reports them. */
export function computeCharges(args: {
  edges: ReadonlyArray<{ debtor: string; cleared: bigint }>;
  clearedTotal: bigint;
  clearingBps: bigint;
  solverBps: bigint;
  members: ReadonlyMap<string, { stake: bigint; limit: bigint }>;
  bondLocked: (account: string) => bigint;
}): { charges: FeeCharge[]; toReserve: bigint; toSolver: bigint } | null {
  if (args.clearedTotal === 0n || (args.clearingBps === 0n && args.solverBps === 0n)) return { charges: [], toReserve: 0n, toSolver: 0n };
  const clearingFee = (args.clearedTotal * args.clearingBps) / 10_000n;
  const solverFee = (args.clearedTotal * args.solverBps) / 10_000n;
  const charges: FeeCharge[] = [];
  let charged = 0n;
  for (const { account, share } of proRataFee(args.edges, args.clearedTotal, clearingFee + solverFee)) {
    const member = args.members.get(account);
    if (!member) return null; // a debtor of a cleared edge is a member in the contract; the read model does not know it
    const take = share < member.stake ? share : member.stake;
    const stake = member.stake - take;
    const room = stake > args.bondLocked(account) ? stake - args.bondLocked(account) : 0n;
    charges.push({ account, take, stake, limit: member.limit < room ? member.limit : room });
    charged += take;
  }
  const toReserve = clearingFee < charged ? clearingFee : charged;
  return { charges, toReserve, toSolver: charged - toReserve };
}

/** The bond that `account` has locked in the deals that are not closed (`bond_locked_of`). */
export function bondLockedOf(db: Database.Database, circleId: string, account: string): bigint {
  const rows = db
    .prepare("SELECT party_a, party_b, bond_each, locked_a, locked_b FROM deals WHERE circle_id = ? AND (party_a = ? OR party_b = ?)")
    .safeIntegers(true)
    .all(circleId, account, account) as Array<{ party_a: string; party_b: string | null; bond_each: bigint; locked_a: bigint; locked_b: bigint }>;
  let total = 0n;
  for (const r of rows) {
    if (r.party_a === account && r.locked_a === 1n) total += r.bond_each;
    if (r.party_b === account && r.locked_b === 1n) total += r.bond_each;
  }
  return total;
}

/** The fees in force for `epoch`: the last change of `fees` that took effect at or before it (the first row comes from the view `get_params` at the start). */
export function feesForEpoch(db: Database.Database, circleId: string, epoch: number): { clearingBps: bigint; solverBps: bigint } | null {
  const r = db.prepare("SELECT new_value FROM params WHERE circle_id = ? AND field = 'fees' AND effective_epoch <= ? ORDER BY id DESC LIMIT 1").get(circleId, epoch) as { new_value: string } | undefined;
  if (!r) return null;
  const f = JSON.parse(r.new_value) as { clearing_fee_bps?: number; solver_fee_bps?: number };
  return { clearingBps: BigInt(f.clearing_fee_bps ?? 0), solverBps: BigInt(f.solver_fee_bps ?? 0) };
}

export interface ViewMember {
  account_id: string;
  stake: string;
  limit: string;
}

/**
 * The watch (BE-081): the view `member` of every account against the read model, read when the indexer is at the final head (so the view is the state at the block that was just processed).
 * A member whose stake or limit differs is `stale`: its numbers are taken from the view, and `fee_mismatches` counts it. A member that is equal is not stale any more. Returns the accounts
 * that differed.
 */
export function verifyMembers(db: Database.Database, circleId: string, view: readonly ViewMember[], height: number): string[] {
  const differ: string[] = [];
  db.transaction(() => {
    const read = db.prepare("SELECT stake, credit_limit, stale FROM members WHERE circle_id = ? AND account_id = ?").safeIntegers(true);
    for (const v of view) {
      const m = read.get(circleId, v.account_id) as { stake: bigint; credit_limit: bigint; stale: bigint } | undefined;
      if (!m) continue;
      if (m.stake !== BigInt(v.stake) || m.credit_limit !== BigInt(v.limit)) {
        db.prepare("UPDATE members SET stake = ?, credit_limit = ?, stale = 1, fee_mismatches = fee_mismatches + 1, updated_block = ? WHERE circle_id = ? AND account_id = ?").run(BigInt(v.stake), BigInt(v.limit), height, circleId, v.account_id);
        differ.push(v.account_id);
      } else if (m.stale === 1n) {
        db.prepare("UPDATE members SET stale = 0 WHERE circle_id = ? AND account_id = ?").run(circleId, v.account_id);
      }
    }
  })();
  return differ;
}
