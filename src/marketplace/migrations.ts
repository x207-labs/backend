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

const V1103_NEGOTIATION = `
CREATE TABLE offers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id      TEXT    NOT NULL,
  offer_hash     TEXT    NOT NULL,
  listing_hash   TEXT    NOT NULL,
  proposer       TEXT    NOT NULL,
  counterparty   TEXT    NOT NULL,
  awaiting       TEXT    NOT NULL,
  round          INTEGER NOT NULL,
  mode           TEXT    NOT NULL CHECK (mode IN ('pay','barter')),
  value          TEXT    NOT NULL,
  quantity       INTEGER NOT NULL,
  deliver_by     INTEGER NOT NULL,
  signature      TEXT    NOT NULL,
  in_reply_to    TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','countered','accepted','closed')),
  created_at_ms  INTEGER NOT NULL,
  UNIQUE (circle_id, offer_hash)
);
CREATE INDEX idx_offers_listing ON offers (circle_id, listing_hash, counterparty, round);
CREATE INDEX idx_offers_awaiting ON offers (circle_id, awaiting, status);

CREATE TABLE matches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id        TEXT    NOT NULL,
  listing_hash     TEXT    NOT NULL,
  offer_hash       TEXT    NOT NULL,
  seller           TEXT    NOT NULL,
  counterparty     TEXT    NOT NULL,
  mode             TEXT    NOT NULL,
  kind             TEXT    NOT NULL CHECK (kind IN ('payment','bundle')),
  epoch            INTEGER NOT NULL,
  terms_hash       TEXT,
  listing_value    TEXT    NOT NULL,
  discount_value   TEXT    NOT NULL,
  searcher_account TEXT,
  searcher_value   TEXT    NOT NULL,
  matched_at_ms    INTEGER NOT NULL,
  UNIQUE (circle_id, listing_hash)
);

CREATE TABLE bundle_proposals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id      TEXT    NOT NULL,
  terms_hash     TEXT    NOT NULL,
  match_id       INTEGER NOT NULL REFERENCES matches(id),
  epoch          INTEGER NOT NULL,
  terms_json     TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','ready')),
  created_at_ms  INTEGER NOT NULL,
  UNIQUE (circle_id, terms_hash)
);

CREATE TABLE bundle_signatures (
  circle_id      TEXT NOT NULL,
  terms_hash     TEXT NOT NULL,
  account_id     TEXT NOT NULL,
  signature      TEXT NOT NULL,
  signed_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (circle_id, terms_hash, account_id)
);
`;

// Usulan bundle dari solver (SV-011) tidak punya kecocokan listing: match_id boleh NULL dan sumbernya dicatat.
const V1104_SOLVER_PROPOSALS = `
CREATE TABLE bundle_proposals_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id      TEXT    NOT NULL,
  terms_hash     TEXT    NOT NULL,
  match_id       INTEGER REFERENCES matches(id),
  epoch          INTEGER NOT NULL,
  terms_json     TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','ready')),
  source         TEXT    NOT NULL DEFAULT 'accept' CHECK (source IN ('accept','solver')),
  created_at_ms  INTEGER NOT NULL,
  UNIQUE (circle_id, terms_hash)
);
INSERT INTO bundle_proposals_new (id, circle_id, terms_hash, match_id, epoch, terms_json, status, created_at_ms)
  SELECT id, circle_id, terms_hash, match_id, epoch, terms_json, status, created_at_ms FROM bundle_proposals;
DROP TABLE bundle_proposals;
ALTER TABLE bundle_proposals_new RENAME TO bundle_proposals;
`;

// Kotak masuk ajakan pencari (BE-044): pencari menandatangani ajakan, agent tujuan menawar sendiri dengan merujuk hash ajakan.
const V1105_REFERRALS = `
CREATE TABLE referrals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id          TEXT    NOT NULL,
  referral_hash      TEXT    NOT NULL,
  seeker             TEXT    NOT NULL,
  to_account         TEXT    NOT NULL,
  listing_hash       TEXT    NOT NULL,
  mode               TEXT    NOT NULL CHECK (mode IN ('pay','barter')),
  value              TEXT    NOT NULL,
  quantity           INTEGER NOT NULL,
  deliver_by         INTEGER NOT NULL,
  searcher_share_bps INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  nonce              TEXT    NOT NULL,
  signature          TEXT    NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','taken','refused')),
  offer_hash         TEXT,
  created_at_ms      INTEGER NOT NULL,
  UNIQUE (circle_id, referral_hash)
);
CREATE INDEX idx_referrals_to ON referrals (circle_id, to_account, status);
CREATE INDEX idx_referrals_pair ON referrals (circle_id, seeker, to_account, listing_hash);
ALTER TABLE offers ADD COLUMN referral_hash TEXT;
`;

export const MARKETPLACE_MIGRATIONS: readonly Migration[] = [
  { version: 1101, name: "m11_intents", sql: V1101_INTENTS },
  { version: 1102, name: "m11_listings", sql: V1102_LISTINGS },
  { version: 1103, name: "m11_negotiation", sql: V1103_NEGOTIATION },
  { version: 1104, name: "m11_solver_proposals", sql: V1104_SOLVER_PROPOSALS },
  { version: 1105, name: "m11_referrals", sql: V1105_REFERRALS },
];
