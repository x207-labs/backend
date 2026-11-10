// BE-117: `node dist/faucet/topup-cli.js`, one run of the faucet refill (see topup.ts). Run by a systemd timer every 30 minutes on the machine of the faucet.
// Env: `X207_FAUCET_ACCOUNT` (the account to fill; the faucet secret key is NOT read), `X207_FAUCET_RPC_URL` (default https://rpc.testnet.fastnear.com),
// `X207_FAUCET_TOPUP_LOW_YOCTO` (default 3 NEAR), `X207_FAUCET_TOPUP_HIGH_YOCTO` (default 8 NEAR), `X207_FAUCET_TOPUP_MAX_ACCOUNTS` (default 3),
// `X207_FAUCET_TOPUP_HELPER_URL` (default https://helper.nearprotocol.com/account, the service behind `near account create-account sponsor-by-faucet-service`).
import { randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from "near-api-js";
import { runTopup, TOPUP_DEFAULTS, type SweepResult, type TopupConfig, type TopupDeps } from "./topup.js";

const big = (env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return BigInt(raw);
};

export function topupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TopupConfig {
  return {
    lowYocto: big(env, "X207_FAUCET_TOPUP_LOW_YOCTO", TOPUP_DEFAULTS.lowYocto),
    highYocto: big(env, "X207_FAUCET_TOPUP_HIGH_YOCTO", TOPUP_DEFAULTS.highYocto),
    maxAccounts: Number(big(env, "X207_FAUCET_TOPUP_MAX_ACCOUNTS", BigInt(TOPUP_DEFAULTS.maxAccounts))),
  };
}

/** The transaction hash in the answer of the faucet service (a full execution outcome), or null. */
export function createTxFrom(body: unknown): string | null {
  const b = body as { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } } | null;
  const hash = b?.transaction?.hash ?? b?.transaction_outcome?.id;
  return typeof hash === "string" ? hash : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function realDeps(env: NodeJS.ProcessEnv, log: (line: string) => void): TopupDeps {
  const faucetAccount = env.X207_FAUCET_ACCOUNT;
  if (!faucetAccount) throw new Error("X207_FAUCET_ACCOUNT is not set");
  const rpcUrl = env.X207_FAUCET_RPC_URL || "https://rpc.testnet.fastnear.com";
  if (!faucetAccount.endsWith(".testnet") || /mainnet/i.test(rpcUrl) || /^https:\/\/rpc\.near\.org/.test(rpcUrl)) throw new Error("testnet only: the account must end in .testnet and the RPC must be a testnet one");
  const helperUrl = env.X207_FAUCET_TOPUP_HELPER_URL || "https://helper.nearprotocol.com/account";
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const exists = async (accountId: string): Promise<boolean> => {
    try {
      await provider.viewAccount({ accountId });
      return true;
    } catch {
      return false;
    }
  };
  return {
    log,
    balance: async () => BigInt((await provider.viewAccount({ accountId: faucetAccount })).amount),
    async sponsorAndSweep(): Promise<SweepResult> {
      const key = KeyPair.fromRandom("ed25519"); // in memory only: never written, never logged
      const accountId = `x207tmp${randomBytes(5).toString("hex")}.testnet`;
      const res = await fetch(helperUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: key.getPublicKey().toString() }), signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`faucet service answered ${res.status}`);
      let createTx: string | null = null;
      try {
        createTx = createTxFrom(JSON.parse(text));
      } catch {
        createTx = null;
      }
      for (let i = 0; i < 20 && !(await exists(accountId)); i++) await sleep(1500);
      const account = new Account(accountId, provider, new KeyPairSigner(key));
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const out = await account.deleteAccount(faucetAccount);
          return { createTx, deleteTx: out.transaction_outcome.id };
        } catch (err) {
          lastError = err;
          await sleep(2000);
        }
      }
      throw new Error(`created ${accountId} (tx ${createTx ?? "unknown"}) but could not delete it: ${(lastError as Error).message}`);
    },
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const log = (line: string) => console.log(`${new Date().toISOString()} faucet-topup ${line}`);
  runTopup(topupConfigFromEnv(), realDeps(process.env, log))
    .then(() => process.exit(0)) // a refusal by the service is not a failure of the unit: the next run tries again
    .catch((err) => {
      log(`error: ${(err as Error).message.slice(0, 300)}`);
      process.exit(1);
    });
}
