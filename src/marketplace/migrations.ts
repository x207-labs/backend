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

const V1102_LISTINGS = `
CREATE TABLE listings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id        TEXT    NOT NULL,
  listing_hash     TEXT    NOT NULL,
  account_id       TEXT    NOT NULL,
  offer_asset_type TEXT    NOT NULL,
  offer_class      TEXT    NOT NULL,
  offer_quantity   INTEGER NOT NULL,
  offer_value      TEXT    NOT NULL,
  want_asset_type  TEXT    NOT NULL,
  want_class       TEXT    NOT NULL,
  want_quantity    INTEGER NOT NULL,
  want_value       TEXT    NOT NULL,
  terms            TEXT    NOT NULL,
  detail           TEXT    NOT NULL,
  expires_at       INTEGER NOT NULL,
  discount_bps     INTEGER NOT NULL,
  accept_payment   INTEGER NOT NULL,
  discoverable     INTEGER NOT NULL,
  nonce            TEXT    NOT NULL,
  signature        TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','matched','cancelled')),
  created_at_ms    INTEGER NOT NULL,
  closed_at_ms     INTEGER,
  UNIQUE (circle_id, listing_hash)
);
CREATE INDEX idx_listings_status ON listings (circle_id, status, expires_at);
CREATE INDEX idx_listings_account ON listings (circle_id, account_id);
CREATE INDEX idx_listings_offer ON listings (circle_id, offer_asset_type, status);
CREATE INDEX idx_listings_want ON listings (circle_id, want_asset_type, status);
`;

export const MARKETPLACE_MIGRATIONS: readonly Migration[] = [
  { version: 1101, name: "m11_intents", sql: V1101_INTENTS },
  { version: 1102, name: "m11_listings", sql: V1102_LISTINGS },
];
