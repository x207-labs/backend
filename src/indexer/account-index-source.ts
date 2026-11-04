import type { BlockSource, SourceBlock } from "./block-source.js";

export interface AccountIndexSourceOptions {
  /** The source of the blocks (Neardata). Only the blocks that can hold a log of the circle are asked from it. */
  inner: BlockSource;
  /** `POST {txIndexUrl}` with `{account_id, limit, resume_token?}`, newest first; e.g. `https://tx.test.fastnear.com/v0/account` (FastNEAR). */
  txIndexUrl: string;
  contractId: string;
  fetch?: typeof fetch;
  /** The blocks after the block of a transaction in which its receipts can run (a call, its callback, a token transfer); default 8. */
  spanBlocks?: number;
  /** How far behind the final head the source stops, so that the index has had time to list the transactions of the last blocks; default 90 blocks (about 1.5 minutes). */
  marginBlocks?: number;
  /** At least this long between two reads of the index; default 5 seconds. */
  refreshMs?: number;
  /** At least this long between two requests to the inner source (the free Neardata answers 429 above 30 blocks a minute); default 0. */
  minIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * BE-089: follows a circle on testnet without walking every block. The index of the account (FastNEAR) lists the transactions that touch the contract; a block is read from the inner
 * source only when it is a block of such a transaction or one of the few after it, any other height is a skipped one (`null`). The source stops `marginBlocks` behind the final head, so a
 * transaction that the index has not listed yet cannot make the indexer skip a block that matters. Free of any key: the index and Neardata are public.
 */
export class AccountIndexBlockSource implements BlockSource {
  readonly #o: Required<Pick<AccountIndexSourceOptions, "spanBlocks" | "marginBlocks" | "refreshMs" | "minIntervalMs">> & AccountIndexSourceOptions;
  readonly #heights = new Set<number>();
  readonly #fetch: typeof fetch;
  #lastRefresh = 0;
  #lastCall = 0;

  constructor(options: AccountIndexSourceOptions) {
    this.#o = { spanBlocks: 8, marginBlocks: 90, refreshMs: 5_000, minIntervalMs: 0, ...options };
    this.#fetch = options.fetch ?? fetch;
  }

  get endpoint(): string {
    return this.#o.inner.endpoint;
  }

  async finalHeight(): Promise<number> {
    const head = await this.#o.inner.finalHeight();
    await this.#refresh();
    return Math.max(0, head - this.#o.marginBlocks);
  }

  async getBlock(height: number): Promise<SourceBlock | null> {
    if (!this.#wanted(height)) return null;
    const gap = this.#lastCall + this.#o.minIntervalMs - (this.#o.now ?? Date.now)();
    if (gap > 0) await (this.#o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(gap);
    this.#lastCall = (this.#o.now ?? Date.now)();
    return this.#o.inner.getBlock(height);
  }

  #wanted(height: number): boolean {
    for (let d = 0; d <= this.#o.spanBlocks; d++) if (this.#heights.has(height - d)) return true;
    return false;
  }

  /** Reads the index newest first until a whole page is already known. */
  async #refresh(): Promise<void> {
    const now = (this.#o.now ?? Date.now)();
    if (this.#lastRefresh !== 0 && now - this.#lastRefresh < this.#o.refreshMs) return;
    let token: string | null = null;
    for (let page = 0; page < 200; page++) {
      const response = await this.#fetch(this.#o.txIndexUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: this.#o.contractId, limit: 200, ...(token === null ? {} : { resume_token: token }) }), signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`transaction index answered ${response.status}`);
      const body = (await response.json()) as { account_txs?: Array<{ tx_block_height?: number }>; resume_token?: string | null };
      let fresh = 0;
      for (const tx of body.account_txs ?? []) {
        if (typeof tx.tx_block_height === "number" && !this.#heights.has(tx.tx_block_height)) {
          this.#heights.add(tx.tx_block_height);
          fresh++;
        }
      }
      token = body.resume_token ?? null;
      // newest first: a page with nothing new means everything older is known already (the first read has no known heights, so it reads to the end)
      if (token === null || (fresh === 0 && this.#lastRefresh !== 0)) break;
    }
    this.#lastRefresh = now;
  }
}
