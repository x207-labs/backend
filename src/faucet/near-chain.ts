// BE-114: the real `FaucetChain`, on testnet with near-api-js. The secret key is given to the constructor by `faucetFromEnv` and kept in the signer only; it is never logged or returned.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import type { FaucetChain, FaucetConfig } from "./faucet.js";
import { FAUCET_DEFAULTS } from "./faucet.js";

const STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, what the mock USDT keeps per account
const GAS = 30_000_000_000_000n;

export class NearFaucetChain implements FaucetChain {
  private readonly provider: JsonRpcProvider;
  private readonly account: Account;
  constructor(private readonly opts: { rpcUrl: string; accountId: string; secretKey: string; usdtContract: string }) {
    this.provider = new JsonRpcProvider({ url: opts.rpcUrl });
    this.account = new Account(opts.accountId, this.provider, new KeyPairSigner(KeyPair.fromString(opts.secretKey as KeyPairString)));
  }

  async balance(accountId: string): Promise<bigint | null> {
    try {
      return BigInt((await this.provider.viewAccount({ accountId })).amount);
    } catch (err) {
      if (/does not exist|UNKNOWN_ACCOUNT|UnknownAccount/i.test(`${(err as Error).name} ${(err as Error).message}`)) return null;
      throw err;
    }
  }

  async faucetBalance(): Promise<bigint> {
    return BigInt((await this.provider.viewAccount({ accountId: this.opts.accountId })).amount);
  }

  async transfer(accountId: string, yocto: bigint): Promise<string> {
    const out = await this.account.transfer({ receiverId: accountId, amount: yocto });
    return out.transaction_outcome.id;
  }

  async fundUsdt(accountId: string, amount: bigint): Promise<string[]> {
    const deposit = await this.account.callFunctionRaw({ contractId: this.opts.usdtContract, methodName: "storage_deposit", args: { account_id: accountId }, deposit: STORAGE_DEPOSIT, gas: GAS, waitUntil: "FINAL" });
    const mint = await this.account.callFunctionRaw({ contractId: this.opts.usdtContract, methodName: "mint", args: { account_id: accountId, amount: amount.toString() }, deposit: 0n, gas: GAS, waitUntil: "FINAL" });
    return [deposit.transaction_outcome.id, mint.transaction_outcome.id];
  }
}

const big = (env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return BigInt(raw);
};
const int = (env: NodeJS.ProcessEnv, name: string, fallback: number): number => Number(big(env, name, BigInt(fallback)));

/**
 * Off unless `X207_FAUCET_ACCOUNT` and `X207_FAUCET_KEY` are both set. Testnet only: it refuses a mainnet RPC and an account that is not `*.testnet`.
 * Env: `X207_FAUCET_ACCOUNT`, `X207_FAUCET_KEY` (ed25519:... secret, in the env file of the unit only), `X207_FAUCET_USDT` (default `usdt.x207-deployer.testnet`),
 * `X207_FAUCET_RPC_URL` (default `https://rpc.testnet.fastnear.com`), `X207_FAUCET_NEAR_YOCTO`, `X207_FAUCET_USDT_AMOUNT`, `X207_FAUCET_PER_IP_PER_DAY`, `X207_FAUCET_PER_DAY`,
 * `X207_FAUCET_FUNDED_ABOVE_YOCTO`, `X207_FAUCET_RESERVE_YOCTO`.
 */
export function faucetFromEnv(env: NodeJS.ProcessEnv = process.env): { chain: FaucetChain; config: FaucetConfig } | undefined {
  const accountId = env.X207_FAUCET_ACCOUNT;
  const secretKey = env.X207_FAUCET_KEY;
  if (!accountId && !secretKey) return undefined;
  if (!accountId || !secretKey) throw new Error("X207_FAUCET_ACCOUNT and X207_FAUCET_KEY must be set together");
  const rpcUrl = env.X207_FAUCET_RPC_URL || "https://rpc.testnet.fastnear.com";
  if (!accountId.endsWith(".testnet") || /mainnet/i.test(rpcUrl) || /^https:\/\/rpc\.near\.org/.test(rpcUrl)) throw new Error("the faucet pays testnet funds only: the account must end in .testnet and the RPC must be a testnet one");
  if (!/^ed25519:/.test(secretKey)) throw new Error("X207_FAUCET_KEY must be an ed25519 secret key");
  const usdtContract = env.X207_FAUCET_USDT || "usdt.x207-deployer.testnet";
  const d = FAUCET_DEFAULTS;
  const config: FaucetConfig = {
    nearYocto: big(env, "X207_FAUCET_NEAR_YOCTO", d.nearYocto),
    usdtAmount: big(env, "X207_FAUCET_USDT_AMOUNT", d.usdtAmount),
    usdtContract,
    perIpPerDay: int(env, "X207_FAUCET_PER_IP_PER_DAY", d.perIpPerDay),
    perDay: int(env, "X207_FAUCET_PER_DAY", d.perDay),
    fundedAboveYocto: big(env, "X207_FAUCET_FUNDED_ABOVE_YOCTO", d.fundedAboveYocto),
    reserveYocto: big(env, "X207_FAUCET_RESERVE_YOCTO", d.reserveYocto),
  };
  return { chain: new NearFaucetChain({ rpcUrl, accountId, secretKey, usdtContract }), config };
}
