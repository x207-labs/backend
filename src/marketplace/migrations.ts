import type { Migration } from "../db/migrations.js";

/**
 * M11 tables (barter marketplace, D8 and D12). Versions 1100+ so they do not collide with the D9 migrations (1, 2, ...).
 * Credit values are stored as decimal TEXT (U128 exceeds SQLite INTEGER); `expires_at` times are in unix seconds.
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

// A bundle proposal from a solver (SV-011) has no listing match: match_id may be NULL and its source is recorded.
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

// Searcher referral inbox (BE-044): the searcher signs a referral, the target agent bids on its own by referring to the referral hash.
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

// BE-056, hash scheme of the SDK (review BE-062 F1, F2, F11, F12): the hash of a content and of a ciphertext changed (one scheme with the leaf prefix, the sizes in the signed release),
// so a purchase that is not final, and a license listing that is open, were made with hashes that the new SDK does not produce. The vouchers of those purchases were held and never released,
// so they are cancelled (nothing moves); the sellers list again. Purchases that are `confirmed`, `refuted` or already `cancelled` stay as they are.
const V1112_HASH_SCHEME = `
UPDATE purchases SET status = 'cancelled', dispute_reason = COALESCE(dispute_reason, 'hash_scheme_changed'), closed_at_ms = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE status IN ('paid_held','cipher_posted','key_released','disputed');
UPDATE listings SET status = 'cancelled', closed_at_ms = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE status = 'open' AND json_valid(detail) AND json_extract(detail, '$.kind') = 'license' AND json_extract(detail, '$.license_doc') IS NOT NULL;
`;

// BE-055 fix (SD-072): a delegate order keeps its mandate; the seller claims each vote (a call to the DAO, not an event of the circle) and the backend checks the transaction through RPC.
const V1113_DELEGATE_CLAIMS = `
ALTER TABLE orders ADD COLUMN mandate_json TEXT;
CREATE TABLE order_claims (
  circle_id     TEXT    NOT NULL,
  order_hash    TEXT    NOT NULL,
  proposal_id   INTEGER NOT NULL,
  tx_hash       TEXT    NOT NULL,
  signer        TEXT    NOT NULL,
  receiver      TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  proposal_kind TEXT    NOT NULL,
  notice_json   TEXT    NOT NULL,
  signature     TEXT    NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (circle_id, order_hash, proposal_id),
  UNIQUE (circle_id, tx_hash)
);
CREATE TABLE order_proposal_kinds (
  dao         TEXT    NOT NULL,
  proposal_id INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  PRIMARY KEY (dao, proposal_id)
);
`;

// BE-069 (ADR-48): a one-time code is sold with the fair exchange of BE-056. `kind` tells the purchase of a license from the purchase of a code; `code_checks` keeps the answer of the issuer for a listing
// (never the code, never the salt).
const V1114_CODES = `
ALTER TABLE purchases ADD COLUMN kind TEXT NOT NULL DEFAULT 'license';
CREATE TABLE code_checks (
  circle_id     TEXT    NOT NULL,
  listing_hash  TEXT    NOT NULL,
  verdict       TEXT    NOT NULL CHECK (verdict IN ('valid','used','unknown')),
  checked_at_ms INTEGER NOT NULL,
  PRIMARY KEY (circle_id, listing_hash)
);
`;

// BE-069 fix (ADR-48): codes that the backend has seen at the check, as an HMAC with a key of the operator (never the plain code, never a plain hash that could be tried against codes of low entropy).
const V1115_CODE_SEEN = `
CREATE TABLE code_seen (
  circle_id    TEXT NOT NULL,
  mac          TEXT NOT NULL,
  listing_hash TEXT NOT NULL,
  seen_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (circle_id, mac, listing_hash)
);
CREATE INDEX idx_code_seen_listing ON code_seen (circle_id, listing_hash);
`;

// BE-069 fix (ADR-48 points 5 to 7): a buyer of a code who says `other` or `contains_pii` without a proof of cheating does not stop the sale: it is a complaint against the seller, one per purchase,
// and the purchase goes on to the automatic confirmation.
const V1116_COMPLAINTS = `
CREATE TABLE purchase_complaints (
  circle_id     TEXT    NOT NULL,
  purchase_id   INTEGER NOT NULL REFERENCES purchases(id),
  seller        TEXT    NOT NULL,
  buyer         TEXT    NOT NULL,
  reason        TEXT    NOT NULL,
  at_s          INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (circle_id, purchase_id)
);
CREATE INDEX idx_complaints_seller ON purchase_complaints (circle_id, seller);
`;

// BE-074 (P4, ADR-49): the purchases of a transfer through the official feature of a platform. Apart from `purchases` (a file or a code): there is no ciphertext, the proof is the platform's.
// The voucher is held here until the proof is met (`confirmed`) or the window of the platform passes (`cancelled`, the voucher never moves).
const V1117_TRANSFERS = `
CREATE TABLE transfers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id         TEXT    NOT NULL,
  listing_hash      TEXT    NOT NULL,
  buyer             TEXT    NOT NULL,
  seller            TEXT    NOT NULL,
  platform          TEXT    NOT NULL CHECK (platform IN ('domain','game_item','ticket')),
  proof_method      TEXT    NOT NULL CHECK (proof_method IN ('dns_txt','trade_api','buyer_confirm')),
  transfer_ref      TEXT    NOT NULL,
  buyer_ref         TEXT,
  tradeoffer_id     TEXT,
  voucher_json      TEXT    NOT NULL,
  voucher_signature TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'paid_held' CHECK (status IN ('paid_held','confirmed','cancelled')),
  window_until      INTEGER NOT NULL,
  proof_json        TEXT,
  confirm_notice    TEXT,
  confirm_signature TEXT,
  cancel_reason     TEXT,
  created_at_ms     INTEGER NOT NULL,
  closed_at_ms      INTEGER
);
CREATE INDEX idx_transfers_listing ON transfers (circle_id, listing_hash);
CREATE INDEX idx_transfers_buyer ON transfers (circle_id, buyer, status);
`;

// B7-C9: the signed notice of a code check is taken once.
// UM-096 fix: a buyer's cancel of a transfer with an objective proof (domain, game item) is a request that the proof can still overrule inside the window.
const V1119_TRANSFER_CANCEL_REQUEST = `
ALTER TABLE transfers ADD COLUMN cancel_requested_ms INTEGER;
`;

const V1118_CODE_CHECK_NOTICES = `
CREATE TABLE code_check_notices (
  circle_id   TEXT NOT NULL,
  notice_hash TEXT NOT NULL,
  PRIMARY KEY (circle_id, notice_hash)
);
`;

// BE-114: one row per account that asked for test funds; the primary key is what refuses a second grant to the same account
const V1120_FAUCET = `
CREATE TABLE faucet_grants (
  account_id    TEXT PRIMARY KEY,
  ip            TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('pending', 'near_sent', 'sent')),
  near_yocto    TEXT NOT NULL,
  usdt_amount   TEXT NOT NULL,
  near_tx       TEXT,
  usdt_txs      TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX faucet_grants_by_ip ON faucet_grants (ip, created_at_ms);
CREATE INDEX faucet_grants_by_time ON faucet_grants (created_at_ms);
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
  { version: 1112, name: "m11_hash_scheme", sql: V1112_HASH_SCHEME },
  { version: 1113, name: "m11_delegate_claims", sql: V1113_DELEGATE_CLAIMS },
  { version: 1114, name: "m11_codes", sql: V1114_CODES },
  { version: 1115, name: "m11_code_seen", sql: V1115_CODE_SEEN },
  { version: 1116, name: "m11_complaints", sql: V1116_COMPLAINTS },
  { version: 1117, name: "m11_transfers", sql: V1117_TRANSFERS },
  { version: 1118, name: "m11_code_check_notices", sql: V1118_CODE_CHECK_NOTICES },
  { version: 1119, name: "m11_transfer_cancel_request", sql: V1119_TRANSFER_CANCEL_REQUEST },
  { version: 1120, name: "m11_faucet", sql: V1120_FAUCET },
];
