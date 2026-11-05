import { Account, JsonRpcProvider, KeyPairSigner } from "near-api-js";
import { DeleteKeyDoesNotExistActionError } from "near-api-js/rpc-errors";
import type { AccessGrant, AccountId, RevokeReason } from "@x207/core";
import { parseFunctionCallKeyScope } from "@x207/core";

/** Everything the broker does on NEAR. Tests replace it with a fake; `NearBrokerChain` is the real one. */
export interface BrokerChain {
  /** `get_grant` view; `null` when the grant does not exist. */
  getGrant(grantId: number): Promise<AccessGrant | null>;
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

/**
 * BE-099: the one error that means "the key to delete is not on the account": the action `DeleteKey` failed with `DeleteKeyDoesNotExist`.
 * `UNKNOWN_ACCESS_KEY` is NOT such an error: the node says it when it cannot find the key of the SIGNER (a node that is behind after a jump of block time, a wrong key),
 * and treating it as "gone" closed the lease with the key still on the account (flaky E2E `broker-class-b`, key present after the expiry sweep).
 */
export function isKeyAlreadyGone(error: unknown): boolean {
  // BE-100 (L1): the class of near-api-js 7 first (that is what `deleteKey` throws), the name second; the text is only a fallback for an error that lost its class
  if (error instanceof DeleteKeyDoesNotExistActionError || (error as { name?: unknown } | undefined)?.name === "DeleteKeyDoesNotExistActionError") return true;
  let text = String((error as Error | undefined)?.message ?? "");
  try {
    text += JSON.stringify(error);
  } catch {
    /* circular error object: the message is enough */
  }
  return /DeleteKeyDoesNotExist/.test(text);
}

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
      if (isKeyAlreadyGone(error)) return "";
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
