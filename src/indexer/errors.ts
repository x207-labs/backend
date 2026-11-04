export interface UnhandledRow {
  receiptId: string;
  logIndex: number;
}

/**
 * The indexer must stop: the block transaction is rolled back and the cursor does not advance. With `keepRow`, the
 * triggering `events_raw` row is kept with `handled = 0` after the rollback (Spec Skema D9 4, `epoch_cutoff`).
 */
export class IndexerHaltError extends Error {
  row: UnhandledRow | undefined;
  constructor(message: string, readonly keepRow = false) {
    super(message);
    this.name = "IndexerHaltError";
  }
}
