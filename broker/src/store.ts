import Database from "better-sqlite3";

export interface Lease {
  grantId: number;
  publicKey: string;
  /** Unix ms until which the rent is paid. */
  paidUntilMs: number;
  /** The key is on the lease sub-account. */
  keyAdded: boolean;
  /** The key was deleted; the lease is over. */
  closed: boolean;
}

interface LeaseRow {
  grant_id: number;
  public_key: string;
  paid_until_ms: number;
  key_added: number;
  closed: number;
}

const toLease = (r: LeaseRow): Lease => ({ grantId: r.grant_id, publicKey: r.public_key, paidUntilMs: r.paid_until_ms, keyAdded: r.key_added === 1, closed: r.closed === 1 });

/** SQLite state of the broker: the leases, and the cursor of the watcher (BK-003). */
export class BrokerStore {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        grant_id      INTEGER PRIMARY KEY,
        public_key    TEXT    NOT NULL,
        paid_until_ms INTEGER NOT NULL,
        key_added     INTEGER NOT NULL DEFAULT 0,
        closed        INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS calls (grant_id INTEGER NOT NULL, epoch INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (grant_id, epoch));
      CREATE TABLE IF NOT EXISTS cursor (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen_events (receipt_id TEXT NOT NULL, log_index INTEGER NOT NULL, PRIMARY KEY (receipt_id, log_index));
    `);
  }

  lease(grantId: number): Lease | undefined {
    const r = this.db.prepare("SELECT * FROM leases WHERE grant_id = ?").get(grantId) as LeaseRow | undefined;
    return r && toLease(r);
  }

  openLeases(): Lease[] {
    return (this.db.prepare("SELECT * FROM leases WHERE key_added = 1 AND closed = 0 ORDER BY grant_id").all() as LeaseRow[]).map(toLease);
  }

  openLeasesOf(grantIds: readonly number[]): Lease[] {
    return this.openLeases().filter((l) => grantIds.includes(l.grantId));
  }

  save(lease: Lease): void {
    this.db
      .prepare(
        `INSERT INTO leases (grant_id, public_key, paid_until_ms, key_added, closed) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (grant_id) DO UPDATE SET public_key = excluded.public_key, paid_until_ms = excluded.paid_until_ms,
           key_added = excluded.key_added, closed = excluded.closed`,
      )
      .run(lease.grantId, lease.publicKey, lease.paidUntilMs, lease.keyAdded ? 1 : 0, lease.closed ? 1 : 0);
  }

  /** Calls of a class C grant that the provider answered with success in `epoch`. */
  calls(grantId: number, epoch: number): number {
    return (this.db.prepare("SELECT n FROM calls WHERE grant_id = ? AND epoch = ?").get(grantId, epoch) as { n: number } | undefined)?.n ?? 0;
  }

  /** Calls that were billed, per epoch, oldest first (BE-070). */
  callsByEpoch(grantId: number): Array<{ epoch: number; calls: number }> {
    return (this.db.prepare("SELECT epoch, n FROM calls WHERE grant_id = ? AND n > 0 ORDER BY epoch").all(grantId) as Array<{ epoch: number; n: number }>).map((r) => ({ epoch: r.epoch, calls: r.n }));
  }

  countCall(grantId: number, epoch: number): void {
    this.db.prepare("INSERT INTO calls (grant_id, epoch, n) VALUES (?, ?, 1) ON CONFLICT (grant_id, epoch) DO UPDATE SET n = n + 1").run(grantId, epoch);
  }

  /** Takes one call of `quota` for `epoch` in one statement; `false` when none is left. Parallel requests cannot both take the last one. */
  reserveCall(grantId: number, epoch: number, quota: bigint): boolean {
    const result = this.db
      .prepare("INSERT INTO calls (grant_id, epoch, n) VALUES (?, ?, 1) ON CONFLICT (grant_id, epoch) DO UPDATE SET n = n + 1 WHERE n < ?")
      .run(grantId, epoch, Number(quota));
    return result.changes > 0;
  }

  /** Gives back a call taken by `reserveCall` when the call to the provider did not succeed. */
  releaseCall(grantId: number, epoch: number): void {
    this.db.prepare("UPDATE calls SET n = n - 1 WHERE grant_id = ? AND epoch = ? AND n > 0").run(grantId, epoch);
  }

  cursor(name: string): string | undefined {
    return (this.db.prepare("SELECT value FROM cursor WHERE name = ?").get(name) as { value: string } | undefined)?.value;
  }

  setCursor(name: string, value: string): void {
    this.db.prepare("INSERT INTO cursor (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").run(name, value);
  }

  /** `true` the first time an event is marked, `false` for a repeat. */
  markSeen(receiptId: string, logIndex: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO seen_events (receipt_id, log_index) VALUES (?, ?)").run(receiptId, logIndex).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
