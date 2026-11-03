import type Database from "better-sqlite3";
import { defaultHandlers, type HandlerMap } from "./handlers/index.js";
import { dispatchEventRow, type EventRow } from "./indexer.js";

/** Tabel read model yang dikosongkan saat rebuild; `circles`, `settlement_jobs`, `events_raw`, dan cursor tetap. */
const READ_MODEL_TABLES = ["official_contracts", "member_freezes", "deal_events", "deals", "intent_withdrawals", "intent_book", "escrows", "grants", "asset_classes", "bundle_legs", "bundles", "member_limits", "settlements", "clearing_log", "obligations", "epochs", "members"] as const;

/**
 * Rebuild penuh tanpa RPC (Spec Skema D9 5.3): kosongkan read model, setel `handled = 0`, lalu putar ulang
 * handler dari `events_raw` urut `block_height, receipt_id, log_index`. Baris awal `params` (`init:*`) berasal
 * dari view, bukan event, sehingga dipertahankan.
 */
export function rebuildReadModel(db: Database.Database, circleId: string, handlers: HandlerMap = defaultHandlers): number {
  return db.transaction(() => {
    for (const table of READ_MODEL_TABLES) db.exec(`DELETE FROM ${table}`);
    db.prepare("DELETE FROM params WHERE circle_id = ? AND receipt_id NOT LIKE 'init:%'").run(circleId);
    // Urutan id AUTOINCREMENT (urutan riwayat) dimulai ulang agar hasil rebuild identik dengan run awal.
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('member_limits', 'deal_events')");
    db.exec("UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id), 0) FROM params) WHERE name = 'params'");
    db.exec("UPDATE events_raw SET handled = 0");

    const rows = db
      .prepare("SELECT * FROM events_raw ORDER BY block_height, receipt_id, log_index")
      .safeIntegers(true)
      .all() as unknown as (Omit<EventRow, "block_height" | "log_index" | "block_timestamp_ns"> & {
      block_height: bigint;
      log_index: bigint;
      block_timestamp_ns: bigint;
    })[];
    const mark = db.prepare("UPDATE events_raw SET handled = ? WHERE receipt_id = ? AND log_index = ?");
    for (const raw of rows) {
      const row: EventRow = { ...raw, block_height: Number(raw.block_height), log_index: Number(raw.log_index) };
      mark.run(dispatchEventRow(db, circleId, handlers, row), row.receipt_id, row.log_index);
    }
    return rows.length;
  }).immediate();
}

