// BE-110: the sign history of a NEAR account, for the listing of item #12 (an address that Chain Signatures derives from the account). Source: the transaction index of FastNEAR, the same
// one the indexer uses to follow a circle (`X207_TX_INDEX_URL`, e.g. `https://tx.test.fastnear.com/v0/account`). Two steps, both read-only and free of any key:
//   1. `POST {index}` `{account_id, limit, resume_token}` lists the transactions of the account (newest first) with flags; the ones the account itself sent as a function call are kept;
//   2. `POST {index base}/transactions` `{tx_hashes}` returns each transaction with its receiver and its actions; the answer is a call to `sign` when the receiver is the MPC contract and one
//      of the actions is a `FunctionCall` of `sign`.
// Only transactions that the account signed itself count: the derivation path of the MPC contract uses the account that CALLS `sign`, so a contract that signs on behalf of the account is a
// different account. Both response shapes were read from the public testnet index on 2026-11-08; the code is run against a fake of them in tests and not against a real `sign` call.
import type { AccountHistory } from "./account-escrow.js";

export interface FastNearHistoryOptions {
  /** The index of the account: `https://tx.test.fastnear.com/v0/account`. The transactions endpoint is the same path with `/transactions` in place of `/account`. */
  txIndexUrl: string;
  /** The MPC contract: `v1.signer-prod.testnet` on testnet, `v1.signer` on mainnet. */
  mpcContractId: string;
  fetch?: typeof fetch;
  /** At most this many pages of 200 transactions are read; more is `complete: false`. Default 25 (5000 transactions). */
  maxPages?: number;
}

interface IndexEntry {
  transaction_hash?: unknown;
  is_signer?: unknown;
  is_any_signer?: unknown;
  is_function_call?: unknown;
}

interface TxAnswer {
  transaction?: { receiver_id?: unknown; actions?: unknown };
}

const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

export class FastNearAccountHistory implements AccountHistory {
  readonly #o: Required<Pick<FastNearHistoryOptions, "maxPages">> & FastNearHistoryOptions;
  readonly #fetch: typeof fetch;

  constructor(options: FastNearHistoryOptions) {
    this.#o = { maxPages: 25, ...options };
    this.#fetch = options.fetch ?? fetch;
  }

  async signCalls(accountId: string): Promise<{ count: number; complete: boolean }> {
    const hashes: string[] = [];
    let token: string | null = null;
    let complete = false;
    for (let page = 0; page < this.#o.maxPages; page++) {
      const body: { account_txs?: IndexEntry[]; resume_token?: string | null } = await this.#post<{ account_txs?: IndexEntry[]; resume_token?: string | null }>(this.#o.txIndexUrl, { account_id: accountId, limit: 200, ...(token === null ? {} : { resume_token: token }) });
      for (const tx of body.account_txs ?? []) {
        if ((tx.is_signer === true || tx.is_any_signer === true) && tx.is_function_call === true && typeof tx.transaction_hash === "string" && HASH.test(tx.transaction_hash)) hashes.push(tx.transaction_hash);
      }
      token = body.resume_token ?? null;
      if (token === null) {
        complete = true;
        break;
      }
    }
    let count = 0;
    const url = this.#o.txIndexUrl.replace(/\/account\/?$/, "/transactions");
    for (let i = 0; i < hashes.length; i += 20) {
      const answer = await this.#post<{ transactions?: TxAnswer[] }>(url, { tx_hashes: hashes.slice(i, i + 20) });
      for (const t of answer.transactions ?? []) if (this.#isSign(t)) count++;
    }
    return { count, complete };
  }

  #isSign(t: TxAnswer): boolean {
    if (t.transaction?.receiver_id !== this.#o.mpcContractId || !Array.isArray(t.transaction.actions)) return false;
    return (t.transaction.actions as Array<{ FunctionCall?: { method_name?: unknown } }>).some((a) => a?.FunctionCall?.method_name === "sign");
  }

  async #post<T>(url: string, payload: unknown): Promise<T> {
    const response = await this.#fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`transaction index answered ${response.status}`);
    return (await response.json()) as T;
  }
}
