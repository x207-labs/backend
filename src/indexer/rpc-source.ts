import type { BlockLog, BlockSource, SourceBlock } from "./block-source.js";
import type { FailoverRpcClient } from "./rpc-client.js";

export interface ChainTx {
  hash: string;
  signerId: string;
  /** First method the transaction calls, when the chunk shows the actions. */
  methodName?: string | null;
}

export interface ChainOutcome {
  receiptId: string;
  executorId: string;
  logs: string[];
  /** Blok tempat outcome ini dieksekusi. */
  blockHash: string;
}

export interface ChainBlock {
  height: number;
  hash: string;
  timestampNs: bigint;
  /** Chunk yang baru dimasukkan di blok ini (`height_included` = tinggi blok). */
  newChunkHashes: string[];
}

/** Bacaan JSON-RPC yang dibutuhkan penelusuran blok → chunk → tx (ADR-34). */
export interface ChainReader {
  readonly endpoint: string;
  finalHeight(): Promise<number>;
  block(height: number): Promise<ChainBlock | null>;
  heightOfBlock(hash: string): Promise<number>;
  chunkTransactions(chunkHash: string): Promise<ChainTx[]>;
  /** Semua outcome receipt satu transaksi, setelah seluruh pohon receipt-nya final. */
  txOutcomes(tx: ChainTx): Promise<ChainOutcome[]>;
}

/**
 * Near-sandbox dan testnet (ADR-34): JSON-RPC standar tidak memberi outcome per blok, jadi tiap transaksi di
 * chunk ditelusuri lewat status `tx` (menunggu FINAL) dan outcome-nya diatribusikan ke blok eksekusinya.
 * Outcome blok H hanya berasal dari transaksi yang dimasukkan di blok < H, jadi `getBlock(H)` memindai
 * blok sampai H − 1. Hanya cocok untuk jaringan kecil; mainnet memakai Neardata.
 */
export class RpcBlockSource implements BlockSource {
  readonly #chain: ChainReader;
  readonly #contractId: string;
  /** Tinggi blok eksekusi → log kontrak yang sudah ditemukan tetapi belum diambil. */
  readonly #found = new Map<number, BlockLog[]>();
  #scanned: number;
  /** Header blok yang baru dibaca; `getBlock(H)` dan pemindaian blok H pada panggilan berikutnya memakainya bersama. */
  readonly #headers = new Map<number, ChainBlock | null>();

  constructor(chain: ChainReader, contractId: string, startBlock: number) {
    this.#chain = chain;
    this.#contractId = contractId;
    // Transaksi sebelum blok mulai tidak dipindai: outcome-nya sebelum `startBlock` juga tidak dibaca.
    this.#scanned = startBlock - 1;
  }

  get endpoint(): string {
    return this.#chain.endpoint;
  }

  finalHeight(): Promise<number> {
    return this.#chain.finalHeight();
  }

  async getBlock(height: number): Promise<SourceBlock | null> {
    const header = await this.#header(height);
    // Pindai transaksi blok yang dilewati/ada sampai height − 1 agar outcome blok `height` sudah dikenal.
    for (let h = this.#scanned + 1; h < height; h++) await this.#scan(h);
    if (header === null) return null;
    const logs = this.#found.get(height) ?? [];
    this.#found.delete(height);
    return { height: header.height, hash: header.hash, timestampNs: header.timestampNs, logs };
  }

  async #header(height: number): Promise<ChainBlock | null> {
    if (this.#headers.has(height)) return this.#headers.get(height) ?? null;
    const block = await this.#chain.block(height);
    this.#headers.set(height, block);
    for (const key of this.#headers.keys()) if (key < height - 2) this.#headers.delete(key);
    return block;
  }

  async #scan(height: number): Promise<void> {
    const block = await this.#header(height);
    if (block) {
      for (const chunkHash of block.newChunkHashes) {
        for (const tx of await this.#chain.chunkTransactions(chunkHash)) await this.#collect(tx);
      }
    }
    this.#scanned = height;
  }

  async #collect(tx: ChainTx): Promise<void> {
    for (const outcome of await this.#chain.txOutcomes(tx)) {
      if (outcome.executorId !== this.#contractId || outcome.logs.length === 0) continue;
      const at = await this.#chain.heightOfBlock(outcome.blockHash);
      const list = this.#found.get(at) ?? [];
      outcome.logs.forEach((log, logIndex) => {
        list.push({ receiptId: outcome.receiptId, logIndex, executorId: outcome.executorId, txHash: tx.hash, signerId: tx.signerId, methodName: tx.methodName ?? null, log });
      });
      this.#found.set(at, list);
    }
  }
}

interface RpcBlockLike {
  header: { height: number; hash: string; timestamp_nanosec: string };
  chunks: { chunk_hash: string; height_included: number }[];
}
interface RpcChunkLike {
  transactions: { hash: string; signer_id: string; actions?: Array<{ FunctionCall?: { method_name?: string } }> }[];
}
interface RpcTxLike {
  receipts_outcome?: { id: string; block_hash: string; outcome: { executor_id: string; logs: string[] } }[];
}

/** Adaptor `ChainReader` di atas `FailoverRpcClient` (near-api-js). */
export function rpcChainReader(client: FailoverRpcClient): ChainReader {
  const heights = new Map<string, number>();
  return {
    get endpoint() {
      return client.activeEndpoint;
    },
    finalHeight: async () => (await client.getFinalBlock()).header.height,
    async block(height) {
      const raw = (await client.getBlock(height)) as unknown as RpcBlockLike | null;
      if (raw === null) return null;
      heights.set(raw.header.hash, raw.header.height);
      return {
        height: raw.header.height,
        hash: raw.header.hash,
        timestampNs: BigInt(raw.header.timestamp_nanosec),
        newChunkHashes: raw.chunks.filter((c) => c.height_included === raw.header.height).map((c) => c.chunk_hash),
      };
    },
    async heightOfBlock(hash) {
      const known = heights.get(hash);
      if (known !== undefined) return known;
      const raw = (await client.use((p) => p.viewBlock({ blockId: hash }))) as unknown as RpcBlockLike;
      heights.set(hash, raw.header.height);
      return raw.header.height;
    },
    async chunkTransactions(chunkHash) {
      const raw = (await client.use((p) => p.viewChunk(chunkHash))) as unknown as RpcChunkLike;
      return raw.transactions.map((t) => ({ hash: t.hash, signerId: t.signer_id, methodName: t.actions?.find((a) => a.FunctionCall !== undefined)?.FunctionCall?.method_name ?? null }));
    },
    async txOutcomes(tx) {
      const raw = (await client.use((p) =>
        p.viewTransactionStatus({ txHash: tx.hash, accountId: tx.signerId, waitUntil: "FINAL" }),
      )) as unknown as RpcTxLike;
      return (raw.receipts_outcome ?? []).map((o) => ({
        receiptId: o.id,
        executorId: o.outcome.executor_id,
        logs: o.outcome.logs,
        blockHash: o.block_hash,
      }));
    },
  };
}

