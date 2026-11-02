import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import type { AccessGrant, AccountId, GrantRole, RevokeReason } from "@x207/core";
import { parseFunctionCallKeyScope } from "@x207/core";

/** Everything the broker does on NEAR. Tests replace it with a fake; `NearBrokerChain` is the real one. */
export interface BrokerChain {
  /** `get_grant` view; `null` when the grant does not exist. */
  getGrant(grantId: number): Promise<AccessGrant | null>;
  /** `grants_of` view. */
  grantsOf(account: AccountId, role: GrantRole): Promise<AccessGrant[]>;
  /** The lease sub-account that the keys are added to. */
  readonly leaseAccount: AccountId;
  /** `AddKey` of a function-call key with the limits of the grant scope, signed with the key of the lease sub-account. */
  addLeaseKey(publicKey: string, scope: string): Promise<string>;
  /** `DeleteKey`; a key that is already gone is not an error. */
  deleteLeaseKey(publicKey: string): Promise<string>;
  /** `revoke_grant` signed by the broker account (the `operator` of the grants). */
  revokeGrant(grantId: number, reason: RevokeReason): Promise<{ ok: true; txHash: string } | { ok: false; error: string }>;
  /** Block time in ms, to compare with `expires_at`. */
  nowMs(): Promise<number>;
  /** The running epoch of the circle (`get_epoch`), for the quota per epoch of class C. */
  currentEpoch(): Promise<number>;
}

export interface NearBrokerChainOptions {
  rpcUrl: string;
  contractId: AccountId;
  brokerAccount: AccountId;
  brokerKey: string;
  leaseAccount: AccountId;
  leaseKey: string;
}

type Hash = { transaction_outcome: { id: string } };

export class NearBrokerChain implements BrokerChain {
  readonly leaseAccount: AccountId;
  readonly #options: NearBrokerChainOptions;
  readonly #lease: Account;
  readonly #broker: Account;

  constructor(options: NearBrokerChainOptions) {
    this.#options = options;
    this.leaseAccount = options.leaseAccount;
    const provider = new JsonRpcProvider({ url: options.rpcUrl });
    this.#lease = new Account(options.leaseAccount, provider, KeyPairSigner.fromSecretKey(options.leaseKey as never));
    this.#broker = new Account(options.brokerAccount, provider, KeyPairSigner.fromSecretKey(options.brokerKey as never));
  }

  async #rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await fetch(this.#options.rpcUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x207-broker", method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json()) as { result?: T; error?: unknown };
    if (body.error !== undefined) throw new Error(`RPC ${method}: ${JSON.stringify(body.error)}`);
    return body.result as T;
  }

  async #view<T>(method: string, args: object): Promise<T> {
    const result = await this.#rpc<{ result: number[]; error?: string }>("query", {
      request_type: "call_function", finality: "optimistic", account_id: this.#options.contractId, method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    if (result.error !== undefined) throw new Error(`${method}: ${result.error}`);
    return JSON.parse(Buffer.from(result.result).toString("utf8")) as T;
  }

  getGrant(grantId: number): Promise<AccessGrant | null> {
    return this.#view("get_grant", { grant_id: grantId });
  }

  grantsOf(account: AccountId, role: GrantRole): Promise<AccessGrant[]> {
    return this.#view("grants_of", { account_id: account, role });
  }

  async addLeaseKey(publicKey: string, scope: string): Promise<string> {
    const s = parseFunctionCallKeyScope(scope);
    const result = (await this.#lease.addFunctionCallAccessKey({
      publicKey, contractId: s.receiver_id, methodNames: s.method_names, allowance: BigInt(s.allowance),
    })) as unknown as Hash;
    return result.transaction_outcome.id;
  }

  async deleteLeaseKey(publicKey: string): Promise<string> {
    try {
      const result = (await this.#lease.deleteKey(publicKey)) as unknown as Hash;
      return result.transaction_outcome.id;
    } catch (error) {
      if (/does not exist|UNKNOWN_ACCESS_KEY|DeleteKeyDoesNotExist/.test(String((error as Error).message) + JSON.stringify(error))) return "";
      throw error;
    }
  }

  async revokeGrant(grantId: number, reason: RevokeReason): Promise<{ ok: true; txHash: string } | { ok: false; error: string }> {
    try {
      const result = (await this.#broker.callFunctionRaw({
        contractId: this.#options.contractId, methodName: "revoke_grant", args: { grant_id: grantId, reason }, gas: 50_000_000_000_000n, deposit: 0n,
      })) as unknown as Hash & { status?: { Failure?: unknown } };
      if (result.status?.Failure !== undefined) return { ok: false, error: JSON.stringify(result.status.Failure) };
      return { ok: true, txHash: result.transaction_outcome.id };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  async currentEpoch(): Promise<number> {
    return (await this.#view<{ epoch: number }>("get_epoch", {})).epoch;
  }

  async nowMs(): Promise<number> {
    const block = await this.#rpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "optimistic" });
    return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
  }
}
