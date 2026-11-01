export interface UnhandledRow {
  receiptId: string;
  logIndex: number;
}

/**
 * Indexer harus berhenti: transaksi blok di-rollback dan cursor tidak maju. Dengan `keepRow`, baris
 * `events_raw` pemicunya disimpan dengan `handled = 0` setelah rollback (Spec Skema D9 4, `epoch_cutoff`).
 */
export class IndexerHaltError extends Error {
  row: UnhandledRow | undefined;
  constructor(message: string, readonly keepRow = false) {
    super(message);
    this.name = "IndexerHaltError";
  }
}
