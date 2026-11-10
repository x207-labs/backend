// BE-117: refill of the testnet faucet account. When its balance is under LOW, ask the official testnet faucet service to sponsor a throwaway account (10 NEAR), then delete that
// account with the faucet account as beneficiary, so the NEAR moves over. Repeat until the balance is over HIGH, at most MAX accounts per run. The logic is here with its effects
// injected, so that it is tested without a network; `topup-cli.ts` wires the real ones. Nothing here knows a secret key: the throwaway key lives in memory inside `sponsorAndSweep`.

export const NEAR = 10n ** 24n;

export interface TopupConfig {
  /** Do nothing while the balance is at or over this. */
  lowYocto: bigint;
  /** Stop adding when the balance is over this. */
  highYocto: bigint;
  /** Throwaway accounts per run. */
  maxAccounts: number;
}

export const TOPUP_DEFAULTS: TopupConfig = { lowYocto: 3n * NEAR, highYocto: 8n * NEAR, maxAccounts: 3 };

export interface SweepResult {
  /** Hash of the transaction that created the sponsored account, `null` when the service did not say. */
  createTx: string | null;
  deleteTx: string;
}

export interface TopupDeps {
  balance(): Promise<bigint>;
  /** Creates a sponsored account with a key that is made in memory, deletes it into the faucet account, returns the hashes. Throws when the service refuses or a step fails. */
  sponsorAndSweep(): Promise<SweepResult>;
  /** One line of log: balances and hashes only. */
  log(line: string): void;
}

export interface TopupSummary {
  before: bigint;
  after: bigint;
  /** Accounts created and swept in this run. */
  rounds: number;
  /** Why it ended: `not_needed`, `reached_high`, `max_accounts`, `refused` (a step threw: no retry until the next run), `no_gain` (a round did not raise the balance). */
  reason: "not_needed" | "reached_high" | "max_accounts" | "refused" | "no_gain";
}

const near = (yocto: bigint): string => {
  const whole = yocto / NEAR;
  const frac = ((yocto % NEAR) / 10n ** 20n).toString().padStart(4, "0");
  return `${whole}.${frac}`;
};

export async function runTopup(config: TopupConfig, deps: TopupDeps): Promise<TopupSummary> {
  const before = await deps.balance();
  if (before >= config.lowYocto) {
    deps.log(`balance ${near(before)} NEAR is not under ${near(config.lowYocto)}: nothing to do`);
    return { before, after: before, rounds: 0, reason: "not_needed" };
  }
  deps.log(`balance ${near(before)} NEAR is under ${near(config.lowYocto)}: refilling up to over ${near(config.highYocto)}, at most ${config.maxAccounts} accounts`);
  let balance = before;
  let rounds = 0;
  while (balance <= config.highYocto) {
    if (rounds >= config.maxAccounts) {
      deps.log(`stopped: ${rounds} accounts used, balance ${near(balance)} NEAR`);
      return { before, after: balance, rounds, reason: "max_accounts" };
    }
    let result: SweepResult;
    try {
      result = await deps.sponsorAndSweep();
    } catch (err) {
      // not a retry loop: the official service limits by address and time, so the next run (30 minutes later) tries again
      deps.log(`stopped: a step was refused or failed (${(err as Error).message.slice(0, 200)}); next run tries again`);
      return { before, after: await deps.balance().catch(() => balance), rounds, reason: "refused" };
    }
    rounds += 1;
    const next = await deps.balance();
    deps.log(`round ${rounds}: create tx ${result.createTx ?? "unknown"}, delete tx ${result.deleteTx}, balance ${near(balance)} -> ${near(next)} NEAR`);
    if (next <= balance) {
      deps.log("stopped: the balance did not go up");
      return { before, after: next, rounds, reason: "no_gain" };
    }
    balance = next;
  }
  return { before, after: balance, rounds, reason: "reached_high" };
}
