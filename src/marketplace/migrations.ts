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

// Delivery of an off-chain asset (BE-047): one row per match whose offered asset needs the receiver to confirm, and the signed notices behind it.
const V1106_DELIVERIES = `
CREATE TABLE deliveries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id      TEXT    NOT NULL,
  listing_hash   TEXT    NOT NULL,
  offer_hash     TEXT    NOT NULL,
  match_id       INTEGER NOT NULL REFERENCES matches(id),
  deliverer      TEXT    NOT NULL,
  receiver       TEXT    NOT NULL,
  deliver_by     INTEGER NOT NULL,
  state          TEXT    NOT NULL DEFAULT 'awaiting' CHECK (state IN ('awaiting','delivered','confirmed','disputed','cancelled')),
  proof_hash     TEXT,
  delivered_at   INTEGER,
  confirm_by     INTEGER,
  confirmed_at   INTEGER,
  disputed_at    INTEGER,
  dispute_reason TEXT,
  cancelled_at   INTEGER,
  cancelled_by   TEXT,
  created_at_ms  INTEGER NOT NULL,
  UNIQUE (circle_id, listing_hash)
);
CREATE TABLE delivery_notices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id      TEXT    NOT NULL,
  listing_hash   TEXT    NOT NULL,
  notice_hash    TEXT    NOT NULL,
  actor          TEXT    NOT NULL,
  action         TEXT    NOT NULL,
  at_s           INTEGER NOT NULL,
  proof_hash     TEXT,
  reason         TEXT,
  signature      TEXT    NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (circle_id, notice_hash)
);
`;

// BE-047, second step: a barter match has two handovers (`side` offer: seller to counterparty; `want`: counterparty to seller), and a delivery that
// the receiver leaves alone past the window is confirmed by the passing of time (`auto_confirmed`).
const V1107_DELIVERY_SIDES = `
CREATE TABLE deliveries_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id      TEXT    NOT NULL,
  listing_hash   TEXT    NOT NULL,
  side           TEXT    NOT NULL DEFAULT 'offer' CHECK (side IN ('offer','want')),
  offer_hash     TEXT    NOT NULL,
  match_id       INTEGER NOT NULL REFERENCES matches(id),
  deliverer      TEXT    NOT NULL,
  receiver       TEXT    NOT NULL,
  deliver_by     INTEGER NOT NULL,
  state          TEXT    NOT NULL DEFAULT 'awaiting' CHECK (state IN ('awaiting','delivered','confirmed','disputed','cancelled')),
  proof_hash     TEXT,
  delivered_at   INTEGER,
  confirm_by     INTEGER,
  confirmed_at   INTEGER,
  auto_confirmed INTEGER NOT NULL DEFAULT 0,
  disputed_at    INTEGER,
  dispute_reason TEXT,
  cancelled_at   INTEGER,
  cancelled_by   TEXT,
  created_at_ms  INTEGER NOT NULL,
  UNIQUE (circle_id, listing_hash, side)
);
INSERT INTO deliveries_new (id, circle_id, listing_hash, side, offer_hash, match_id, deliverer, receiver, deliver_by, state, proof_hash, delivered_at, confirm_by,
    confirmed_at, disputed_at, dispute_reason, cancelled_at, cancelled_by, created_at_ms)
  SELECT id, circle_id, listing_hash, 'offer', offer_hash, match_id, deliverer, receiver, deliver_by, state, proof_hash, delivered_at, confirm_by,
    confirmed_at, disputed_at, dispute_reason, cancelled_at, cancelled_by, created_at_ms FROM deliveries;
DROP TABLE deliveries;
ALTER TABLE deliveries_new RENAME TO deliveries;
ALTER TABLE delivery_notices ADD COLUMN side TEXT NOT NULL DEFAULT 'offer';
`;

// Results of random checks of a job (SV-018, BE-053): a verifier that is an active member says, with its voucher key, that a job of a provider gave the expected result or not.
const V1108_SPOT_CHECKS = `
CREATE TABLE spot_checks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id      TEXT    NOT NULL,
  subject        TEXT    NOT NULL,
  verifier       TEXT    NOT NULL,
  job_hash       TEXT    NOT NULL,
  passed         INTEGER NOT NULL CHECK (passed IN (0,1)),
  expected_hash  TEXT,
  got_hash       TEXT,
  at_s           INTEGER NOT NULL,
  notice_hash    TEXT    NOT NULL,
  signature      TEXT    NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (circle_id, notice_hash),
  UNIQUE (circle_id, subject, job_hash)
);
CREATE INDEX idx_spot_checks_subject ON spot_checks (circle_id, subject);
`;

// Invoices and installments (BE-051, ADR-44). The installment row keeps the voucher it waits for (`v_epoch`, `v_seq`, `v_cumulative`): the original one, or the catch-up voucher after a shift.
const V1109_INVOICES = `
CREATE TABLE invoices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id         TEXT    NOT NULL,
  invoice_hash      TEXT    NOT NULL,
  issuer            TEXT    NOT NULL,
  debtor            TEXT    NOT NULL,
  document_json     TEXT    NOT NULL,
  amount            TEXT    NOT NULL,
  installment_count INTEGER NOT NULL,
  first_epoch       INTEGER NOT NULL,
  needs_bond        INTEGER NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','registered','rejected','expired','missed')),
  reject_reason     TEXT,
  request_signature TEXT    NOT NULL,
  created_at_ms     INTEGER NOT NULL,
  decided_at_ms     INTEGER,
  UNIQUE (circle_id, invoice_hash)
);
CREATE INDEX idx_invoices_issuer ON invoices (circle_id, issuer);
CREATE INDEX idx_invoices_debtor ON invoices (circle_id, debtor);
CREATE TABLE invoice_installments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id     TEXT    NOT NULL,
  invoice_hash  TEXT    NOT NULL,
  idx           INTEGER NOT NULL,
  epoch         INTEGER NOT NULL,
  amount        TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','registered','shifted','missed')),
  reason        TEXT    CHECK (reason IN ('headroom','blocked_by_debtor')),
  shifted       INTEGER NOT NULL DEFAULT 0,
  v_epoch       INTEGER,
  v_seq         INTEGER,
  v_cumulative  TEXT,
  voucher_json  TEXT,
  signature     TEXT,
  catch_up_json TEXT,
  catch_up_signature TEXT,
  UNIQUE (circle_id, invoice_hash, idx)
);
`;

// Service orders (BE-054, ADR-45): the order, the signatures of the two parties, a row per milestone (or place for an outcome) and the signed notices behind them.
const V1110_ORDERS = `
CREATE TABLE orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id        TEXT    NOT NULL,
  order_hash       TEXT    NOT NULL,
  kind             TEXT    NOT NULL,
  pattern          TEXT    NOT NULL CHECK (pattern IN ('milestone','outcome','proof')),
  buyer            TEXT    NOT NULL,
  seller           TEXT    NOT NULL,
  order_json       TEXT    NOT NULL,
  budget           TEXT    NOT NULL,
  needs_bond       INTEGER NOT NULL,
  target           TEXT,
  target_verified  INTEGER,
  target_checked_via TEXT,
  epoch0           INTEGER NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','open','closed')),
  created_at_ms    INTEGER NOT NULL,
  UNIQUE (circle_id, order_hash)
);
CREATE INDEX idx_orders_buyer ON orders (circle_id, buyer);
CREATE INDEX idx_orders_seller ON orders (circle_id, seller);
CREATE TABLE order_signatures (
  circle_id  TEXT NOT NULL,
  order_hash TEXT NOT NULL,
  account    TEXT NOT NULL,
  signature  TEXT NOT NULL,
  PRIMARY KEY (circle_id, order_hash, account)
);
CREATE TABLE order_milestones (
  circle_id        TEXT    NOT NULL,
  order_hash       TEXT    NOT NULL,
  idx              INTEGER NOT NULL,
  amount           TEXT    NOT NULL,
  due_at           INTEGER NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','delivered','confirmed','disputed','paid','cancelled')),
  outcome          TEXT    CHECK (outcome IN ('accepted','rejected')),
  deliverable_hash TEXT,
  delivered_at     INTEGER,
  confirm_by       INTEGER,
  confirmed_at     INTEGER,
  auto_confirmed   INTEGER NOT NULL DEFAULT 0,
  dispute_reason   TEXT,
  at_s             INTEGER,
  PRIMARY KEY (circle_id, order_hash, idx)
);
CREATE TABLE order_notices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id        TEXT    NOT NULL,
  order_hash       TEXT    NOT NULL,
  milestone        INTEGER NOT NULL,
  notice_hash      TEXT    NOT NULL,
  actor            TEXT    NOT NULL,
  action           TEXT    NOT NULL,
  at_s             INTEGER NOT NULL,
  deliverable_hash TEXT,
  reason           TEXT,
  signature        TEXT    NOT NULL,
  recorded_at_ms   INTEGER NOT NULL,
  UNIQUE (circle_id, notice_hash)
);
`;

// License purchases (BE-056, ADR-46): the voucher of the buyer is held here, the release of the key and the notices are kept, an exclusive license is recorded per content hash,
// and a takedown is recorded per listing.
const V1111_PURCHASES = `
CREATE TABLE purchases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id         TEXT    NOT NULL,
  listing_hash      TEXT    NOT NULL,
  buyer             TEXT    NOT NULL,
  seller            TEXT    NOT NULL,
  content_hash      TEXT    NOT NULL,
  license_doc       TEXT    NOT NULL,
  license_id        TEXT    NOT NULL,
  exclusive         INTEGER NOT NULL,
  voucher_json      TEXT    NOT NULL,
  voucher_signature TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'paid_held' CHECK (status IN ('paid_held','cipher_posted','key_released','confirmed','disputed','refuted','cancelled')),
  source_kind       TEXT,
  source_ref        TEXT,
  cipher_hash       TEXT,
  release_json      TEXT,
  release_signature TEXT,
  released_at       INTEGER,
  dispute_until     INTEGER,
  auto_confirmed    INTEGER NOT NULL DEFAULT 0,
  dispute_reason    TEXT,
  dispute_proof     TEXT,
  created_at_ms     INTEGER NOT NULL,
  closed_at_ms      INTEGER
);
CREATE INDEX idx_purchases_content ON purchases (circle_id, content_hash);
CREATE INDEX idx_purchases_listing ON purchases (circle_id, listing_hash);
CREATE TABLE purchase_notices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id      TEXT    NOT NULL,
  purchase_id    INTEGER NOT NULL REFERENCES purchases(id),
  notice_hash    TEXT    NOT NULL,
  actor          TEXT    NOT NULL,
  action         TEXT    NOT NULL,
  at_s           INTEGER NOT NULL,
  signature      TEXT    NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (circle_id, notice_hash)
);
CREATE TABLE takedowns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id      TEXT    NOT NULL,
  listing_hash   TEXT    NOT NULL,
  claimant       TEXT    NOT NULL,
  claim          TEXT    NOT NULL,
  evidence_hash  TEXT    NOT NULL,
  signature      TEXT    NOT NULL,
  cancelled_purchases INTEGER NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  UNIQUE (circle_id, listing_hash)
);
`;

export const MARKETPLACE_MIGRATIONS: readonly Migration[] = [
  { version: 1101, name: "m11_intents", sql: V1101_INTENTS },
  { version: 1102, name: "m11_listings", sql: V1102_LISTINGS },
  { version: 1103, name: "m11_negotiation", sql: V1103_NEGOTIATION },
  { version: 1104, name: "m11_solver_proposals", sql: V1104_SOLVER_PROPOSALS },
  { version: 1105, name: "m11_referrals", sql: V1105_REFERRALS },
  { version: 1106, name: "m11_deliveries", sql: V1106_DELIVERIES },
  { version: 1107, name: "m11_delivery_sides", sql: V1107_DELIVERY_SIDES },
  { version: 1108, name: "m11_spot_checks", sql: V1108_SPOT_CHECKS },
  { version: 1109, name: "m11_invoices", sql: V1109_INVOICES },
  { version: 1110, name: "m11_orders", sql: V1110_ORDERS },
  { version: 1111, name: "m11_purchases", sql: V1111_PURCHASES },
];
