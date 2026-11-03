/** Satu log dari outcome receipt yang dieksekusi di sebuah blok. */
export interface BlockLog {
  receiptId: string;
  /** Posisi log di daftar log outcome receipt itu (Spec Skema D9 5.1 langkah 2). */
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
 * Sumber log indexer (ADR-34). Implementasi menghasilkan bentuk yang sama untuk semua jaringan:
 * Neardata FastNEAR di mainnet; penelusuran JSON-RPC di near-sandbox dan testnet.
 */
export interface BlockSource {
  /** Endpoint yang menjawab permintaan terakhir; nilai `indexer_cursor.rpc_endpoint`. */
  readonly endpoint: string;
  /** Tinggi blok final terbaru. */
  finalHeight(): Promise<number>;
  /** Blok final di `height`, atau `null` bila tinggi itu dilewati chain. */
  getBlock(height: number): Promise<SourceBlock | null>;
}
