import type { Migration } from "../db/migrations.js";

/**
 * Tabel M11 (marketplace barter, D8 dan D12). Versi 1100+ agar tidak bertabrakan dengan migrasi D9 (1, 2, ...).
 * Nilai credit disimpan TEXT desimal (U128 melebihi INTEGER SQLite); waktu `expires_at` dalam detik unix.
 */
const V1101_INTENTS = `
CREATE TABLE intents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id        TEXT    NOT NULL,
  intent_hash      TEXT    NOT NULL,
  intent_hash_b58  TEXT    NOT NULL,
  account_id       TEXT    NOT NULL,
  offer_service    TEXT    NOT NULL,
  offer_calls      INTEGER NOT NULL,
  offer_value      TEXT    NOT NULL,
  need_service     TEXT    NOT NULL,
  need_calls       INTEGER NOT NULL,
  need_value       TEXT    NOT NULL,
  expires_at       INTEGER NOT NULL,
  nonce            TEXT    NOT NULL,
  signature        TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched')),
  created_at_ms    INTEGER NOT NULL,
  UNIQUE (circle_id, intent_hash)
);
CREATE INDEX idx_intents_status ON intents (circle_id, status, expires_at);
CREATE INDEX idx_intents_account ON intents (circle_id, account_id);
`;

export const MARKETPLACE_MIGRATIONS: readonly Migration[] = [{ version: 1101, name: "m11_intents", sql: V1101_INTENTS }];
