import type Database from "better-sqlite3";
import { ContractAbi, EVENT_PREFIX, isKnownX207Event, parseEventLog } from "@x207/core";
import type { BlockLog, BlockSource, SourceBlock } from "./block-source.js";
import { IndexerHaltError } from "./errors.js";
import { rawHandlers } from "./handlers/escrow.js";
import { defaultHandlers, type HandlerContext, type HandlerMap } from "./handlers/index.js";
import { verifyMembers, type ViewMember } from "./fee-charges.js";
import { prefetchClearingEdges, type FetchClearedEdges, type PrefetchOptions } from "./clearing-edges.js";
import { assertAmountsInRange } from "./units.js";

/** `events_raw.handled`: 0 belum/gagal diproses, 1 diproses (atau tanpa read model), 2 nama event tak dikenal. */
export const HANDLED = { pending: 0, done: 1, unknown: 2 } as const;

export interface IndexerOptions {
  db: Database.Database;
  source: BlockSource;
  circleId: string;
  contractId: string;
  /** Blok deploy kontrak; blok pertama yang dibaca (Spec Skema D9 5.3). */
  startBlock: number;
  handlers?: HandlerMap;
  /** Hasil view `get_params`, untuk baris awal tabel `params` saat bootstrap. */
  fetchParams?: () => Promise<ContractAbi.Params>;
  /** BE-077: reads the cleared edges of an epoch (view `list_obligations`) for a `clearing_applied` summary; needed to apply interface 0.0.13. */
  fetchClearedEdges?: FetchClearedEdges;
  /** BE-081: reads the stake and the limit of every member (view `list_members`); when the indexer is at the final head after a `clearing_applied`, the read model is checked against it. */
  fetchMembers?: () => Promise<ViewMember[]>;
  /** Retry of that read (tests make it fast). */
  prefetch?: PrefetchOptions;
  now?: () => number;
}

export type StepResult = { kind: "processed"; height: number; events: number } | { kind: "idle" };

interface CursorRow {
  last_block_height: number;
  head_block_height: number;
}

interface EventRow {
  receipt_id: string;
  log_index: number;
  block_height: number;
  block_hash: string;
  block_timestamp_ns: bigint;
  tx_hash: string | null;
  signer_id: string | null;
  method_name: string | null;
  contract_id: string;
  standard: string;
  version: string;
  event: string;
  data_json: string;
  handled: number;
}

const PARAM_FIELDS = [
  "epoch_length", "payment_window", "proposal_window", "base_limit_ratio", "limit_growth", "limit_cap",
  "limit_decay", "fees", "admission",
] as const;

const INSERT_EVENT = `INSERT OR IGNORE INTO events_raw (receipt_id, log_index, block_height, block_hash, block_timestamp_ns,
  tx_hash, signer_id, method_name, contract_id, standard, version, event, data_json, handled)
  VALUES (@receipt_id, @log_index, @block_height, @block_hash, @block_timestamp_ns, @tx_hash, @signer_id, @method_name, @contract_id, @standard,
  @version, @event, @data_json, @handled)`;

/**
 * Inti indexer M6 (BE-006): satu blok final per `step()`, satu transaksi SQLite per blok yang memuat
 * `events_raw`, efek handler, dan kemajuan cursor (Spec Skema D9 5.1).
 */
export class Indexer {
  readonly #db: Database.Database;
  readonly #source: BlockSource;
  readonly #circleId: string;
  readonly #contractId: string;
  readonly #startBlock: number;
  readonly #handlers: HandlerMap;
  readonly #fetchParams: (() => Promise<ContractAbi.Params>) | undefined;
  readonly #now: () => number;
  readonly #fetchEdges: FetchClearedEdges | undefined;
  readonly #prefetch: PrefetchOptions;
  readonly #fetchMembers: (() => Promise<ViewMember[]>) | undefined;
  #head = 0;

  constructor(options: IndexerOptions) {
    this.#db = options.db;
    this.#source = options.source;
    this.#circleId = options.circleId;
    this.#contractId = options.contractId;
    this.#startBlock = options.startBlock;
    this.#handlers = options.handlers ?? defaultHandlers;
    this.#fetchParams = options.fetchParams;
    this.#now = options.now ?? Date.now;
    this.#fetchEdges = options.fetchClearedEdges;
    this.#prefetch = options.prefetch ?? {};
    this.#fetchMembers = options.fetchMembers;
  }

  /** Buat cursor dan baris awal `params` bila belum ada; aman dipanggil berulang. */
  async bootstrap(): Promise<void> {
    const db = this.#db;
    const exists = db.prepare("SELECT 1 FROM indexer_cursor WHERE name = ?").get(this.#contractId);
    const fetchParams = this.#fetchParams;
    const hasParams = db.prepare("SELECT 1 FROM params WHERE circle_id = ? LIMIT 1").get(this.#circleId) !== undefined;
    const params = fetchParams && !hasParams ? await fetchParams() : undefined;

    db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO circles (circle_id, contract_id, network) VALUES (?, ?, ?)").run(
        this.#circleId, this.#contractId, `x207:${this.#circleId}`,
      );
      if (!exists) {
        db.prepare(
          `INSERT INTO indexer_cursor (name, contract_id, start_block_height, last_block_height, last_block_hash,
             last_block_timestamp_ns, head_block_height, lag_blocks, rpc_endpoint, updated_at)
           VALUES (?, ?, ?, ?, '', 0, ?, 0, ?, ?)`,
        ).run(this.#contractId, this.#contractId, this.#startBlock, this.#startBlock - 1, this.#startBlock - 1, this.#source.endpoint, this.#now());
      }
      if (params) {
        const insert = db.prepare(
          `INSERT OR IGNORE INTO params (circle_id, field, old_value, new_value, effective_epoch, block_height, receipt_id, log_index)
           VALUES (?, ?, NULL, ?, 0, ?, ?, 0)`,
        );
        for (const field of PARAM_FIELDS) {
          insert.run(this.#circleId, field, JSON.stringify(params[field]), this.#startBlock, `init:${this.#startBlock}`);
        }
      }
    })();
  }

  /** Proses blok final berikutnya, atau `idle` bila head belum sampai. Error sumber tidak memajukan cursor. */
  async step(): Promise<StepResult> {
    const cursor = this.#cursor();
    const next = cursor.last_block_height + 1;
    if (this.#head < next) this.#head = Math.max(this.#head, await this.#source.finalHeight());
    if (next > this.#head) {
      this.#touchHead(cursor);
      return { kind: "idle" };
    }

    const block = await this.#source.getBlock(next);
    // BE-077: what a handler needs from a view is read before the transaction of the block, never inside it
    if (block) await prefetchClearingEdges(this.#db, this.#circleId, this.#contractId, block, this.#fetchEdges, this.#prefetch);
    const events = this.#commitBlock(next, block);
    // BE-081: the fee that a commit takes from the stake is computed here, not read from an event; at the final head the view says whether the computation was right
    if (this.#fetchMembers && block && next >= this.#head && block.logs.some((l) => l.executorId === this.#contractId && l.log.includes('"clearing_applied"'))) await this.#watchMembers(next);
    return { kind: "processed", height: next, events };
  }

  /** Compare the read model with the view `member`; the view counts only when no block came in between (the final head is still the block that was processed). */
  async #watchMembers(height: number): Promise<void> {
    try {
      const view = await (this.#fetchMembers as () => Promise<ViewMember[]>)();
      if ((await this.#source.finalHeight()) !== height) return;
      verifyMembers(this.#db, this.#circleId, view, height);
    } catch {
      // the watch is not the indexer: a view that does not answer is tried again at the next commit
    }
  }

  /** Baca sampai head, lalu berhenti; berguna untuk test dan catch-up. */
  async drain(maxBlocks = Number.POSITIVE_INFINITY): Promise<number> {
    let processed = 0;
    while (processed < maxBlocks && (await this.step()).kind === "processed") processed += 1;
    return processed;
  }

  /**
   * Loop polling. Error sumber (semua RPC mati, dsb.) dicoba lagi dengan backoff eksponensial; cursor
   * tidak maju. `IndexerHaltError` menghentikan loop dan dilempar ke pemanggil.
   */
  async run(options: { signal: AbortSignal; pollMs?: number; maxBackoffMs?: number; onError?: (error: unknown) => void }): Promise<void> {
    const pollMs = options.pollMs ?? 1_000;
    const maxBackoff = options.maxBackoffMs ?? 30_000;
    let backoff = pollMs;
    while (!options.signal.aborted) {
      try {
        const result = await this.step();
        backoff = pollMs;
        if (result.kind === "idle") await sleep(pollMs, options.signal);
      } catch (error) {
        if (error instanceof IndexerHaltError) throw error;
        options.onError?.(error);
        await sleep(backoff, options.signal);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }

  #cursor(): CursorRow {
    const row = this.#db.prepare("SELECT last_block_height, head_block_height FROM indexer_cursor WHERE name = ?").get(this.#contractId) as
      | CursorRow
      | undefined;
    if (!row) throw new Error("indexer_cursor is empty: call bootstrap() first");
    return row;
  }

  #touchHead(cursor: CursorRow): void {
    const head = Math.max(this.#head, cursor.last_block_height);
    this.#db
      .prepare("UPDATE indexer_cursor SET head_block_height = ?, lag_blocks = ?, rpc_endpoint = ?, updated_at = ? WHERE name = ?")
      .run(head, head - cursor.last_block_height, this.#source.endpoint, this.#now(), this.#contractId);
  }

  #commitBlock(height: number, block: SourceBlock | null): number {
    const db = this.#db;
    let events = 0;
    try {
      db.transaction(() => {
        if (block) {
          const ordered = [...block.logs].sort(compareLogs);
          for (const log of ordered) events += this.#ingest(block, log);
        }
        const head = Math.max(this.#head, height);
        db.prepare(
          `UPDATE indexer_cursor SET last_block_height = ?, last_block_hash = COALESCE(?, last_block_hash),
             last_block_timestamp_ns = COALESCE(?, last_block_timestamp_ns), head_block_height = ?, lag_blocks = ?,
             rpc_endpoint = ?, updated_at = ? WHERE name = ?`,
        ).run(height, block?.hash ?? null, block?.timestampNs ?? null, head, head - height, this.#source.endpoint, this.#now(), this.#contractId);
      }).immediate();
    } catch (error) {
      if (error instanceof IndexerHaltError && error.keepRow && error.row && block) {
        this.#keepUnhandled(block, error);
      }
      throw error;
    }
    return events;
  }

  /** Simpan, setelah rollback, baris pemicu henti dengan `handled = 0` agar terlihat oleh operator. */
  #keepUnhandled(block: SourceBlock, error: IndexerHaltError): void {
    const log = block.logs.find((l) => l.receiptId === error.row?.receiptId && l.logIndex === error.row.logIndex);
    if (!log) return;
    const row = toRow(block, log, this.#contractId);
    if (row) this.#db.prepare(INSERT_EVENT).run({ ...row, handled: HANDLED.pending });
  }

  /** Simpan satu log dan jalankan handler-nya; mengembalikan jumlah event yang diproses. */
  #ingest(block: SourceBlock, log: BlockLog): number {
    if (log.executorId !== this.#contractId || !log.log.startsWith(EVENT_PREFIX)) return 0;
    const row = toRow(block, log, this.#contractId);
    if (!row) return 0;
    // the amount of ft_escrow_held and mt_escrow_held is in the units of another token (up to 2^128 - 1); its handler checks it
    if (row.event !== "ft_escrow_held" && row.event !== "mt_escrow_held") assertAmountsInRange(JSON.parse(row.data_json));

    const inserted = this.#db.prepare(INSERT_EVENT).run({ ...row, handled: HANDLED.pending });
    if (inserted.changes === 0) {
      // Sudah ada: lewati, kecuali baris yang dulu berhenti di tengah jalan (`handled = 0`) dicoba lagi.
      const existing = this.#db
        .prepare("SELECT handled FROM events_raw WHERE receipt_id = ? AND log_index = ?")
        .get(row.receipt_id, row.log_index) as { handled: number };
      if (existing.handled !== HANDLED.pending) return 0;
    }
    try {
      const handled = dispatch(this.#db, this.#circleId, this.#handlers, row);
      this.#db.prepare("UPDATE events_raw SET handled = ? WHERE receipt_id = ? AND log_index = ?").run(handled, row.receipt_id, row.log_index);
    } catch (error) {
      if (error instanceof IndexerHaltError) error.row = { receiptId: row.receipt_id, logIndex: row.log_index };
      throw error;
    }
    return 1;
  }
}

/** Urutan tetap `(receipt_id, log_index)`, sama dengan urutan rebuild (Spec Skema D9 5.3). */
function compareLogs(a: BlockLog, b: BlockLog): number {
  if (a.receiptId !== b.receiptId) return a.receiptId < b.receiptId ? -1 : 1;
  return a.logIndex - b.logIndex;
}

/** Bangun baris `events_raw` dari log; `null` bila bukan event standar `x207`. */
function toRow(block: SourceBlock, log: BlockLog, contractId: string): EventRow | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(log.log.slice(EVENT_PREFIX.length));
  } catch (error) {
    throw new IndexerHaltError(`log ${log.receiptId}#${log.logIndex} is not JSON: ${(error as Error).message}`);
  }
  if (envelope === null || typeof envelope !== "object" || (envelope as { standard?: unknown }).standard !== "x207") return null;
  const { version, event, data } = envelope as { version: string; event: string; data: unknown };
  return {
    receipt_id: log.receiptId,
    log_index: log.logIndex,
    block_height: block.height,
    block_hash: block.hash,
    block_timestamp_ns: block.timestampNs,
    tx_hash: log.txHash,
    signer_id: log.signerId ?? null,
    method_name: log.methodName ?? null,
    contract_id: contractId,
    standard: "x207",
    version,
    event,
    data_json: JSON.stringify(data),
    handled: HANDLED.pending,
  };
}

/** Jalankan handler tiap elemen `data`; mengembalikan nilai `handled` baris. */
function dispatch(db: Database.Database, circleId: string, handlers: HandlerMap, row: EventRow): number {
  const log = `${EVENT_PREFIX}${JSON.stringify({ standard: row.standard, version: row.version, event: row.event, data: JSON.parse(row.data_json) })}`;
  let parsed;
  try {
    parsed = parseEventLog(log);
  } catch (error) {
    throw new IndexerHaltError(`event ${row.event} could not be read: ${(error as Error).message}`);
  }
  if (!parsed) return HANDLED.done;

  const ctx: HandlerContext = {
    db, circleId, receiptId: row.receipt_id, logIndex: row.log_index, txHash: row.tx_hash,
    block: { height: row.block_height, hash: row.block_hash, timestampNs: row.block_timestamp_ns },
  };
  for (const item of parsed) {
    const raw = rawHandlers[item.event];
    if (raw !== undefined) {
      raw(ctx, isKnownX207Event(item) ? (({ event: _event, ...rest }) => rest)(item) : item.data);
      continue;
    }
    if (!isKnownX207Event(item)) return NO_READ_MODEL.has(item.event) ? HANDLED.done : HANDLED.unknown;
    const { event: name, ...data } = item;
    (handlers[name] as ((c: HandlerContext, d: unknown) => void) | undefined)?.(ctx, data);
  }
  return HANDLED.done;
}

/** Event tanpa read model (Spec Skema D9 4): hanya disimpan di `events_raw` dengan `handled = 1`. */
const NO_READ_MODEL = new Set([
  "solver_fee_claimed", "solver_fee_claim_failed", "upgrade_proposed", "upgrade_applied", "intent_posted",
  "stake_withdraw_failed",
]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}

export { dispatch as dispatchEventRow, toRow as eventRowFromLog };
export type { EventRow };
