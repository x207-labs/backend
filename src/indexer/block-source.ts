/** One log from an outcome receipt executed in a block. */
export interface BlockLog {
  receiptId: string;
  /** Position of the log in that outcome receipt's log list (Spec Skema D9 5.1 step 2). */
  logIndex: number;
  executorId: string;
  txHash: string | null;
  /** Account that signed the transaction and the first method it called, when the source knows them (BE-055). */
  signerId?: string | null;
  methodName?: string | null;
  log: string;
}

export interface SourceBlock {
  height: number;
  hash: string;
  timestampNs: bigint;
  logs: BlockLog[];
}

/**
 * Indexer log source (ADR-34). Implementations produce the same shape for all networks:
 * Neardata FastNEAR on mainnet; JSON-RPC tracing on near-sandbox and testnet.
 */
export interface BlockSource {
  /** Endpoint that answered the last request; value of `indexer_cursor.rpc_endpoint`. */
  readonly endpoint: string;
  /** Latest final block height. */
  finalHeight(): Promise<number>;
  /** Final block at `height`, or `null` if the chain skipped that height. */
  getBlock(height: number): Promise<SourceBlock | null>;
}
