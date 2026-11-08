/** One migration step. `version` goes up by one per step and is never changed after release. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * DDL follows Spec Skema D9 section 3 (vault `04 Arsitektur/x207 - Spec Skema D9`).
 * On-chain amounts are stored as INTEGER (6 decimals); 1Click amounts in `settlement_jobs` are TEXT.
 */
const V1_D9_INITIAL = `
CREATE TABLE events_raw (
  receipt_id         TEXT    NOT NULL,
  log_index          INTEGER NOT NULL,
  block_height       INTEGER NOT NULL,
  block_hash         TEXT    NOT NULL,
  block_timestamp_ns INTEGER NOT NULL,
  tx_hash            TEXT,
  contract_id        TEXT    NOT NULL,
  standard           TEXT    NOT NULL,
  version            TEXT    NOT NULL,
  event              TEXT    NOT NULL,
  data_json          TEXT    NOT NULL,
  handled            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (receipt_id, log_index)
);
CREATE INDEX idx_events_block ON events_raw (block_height);
CREATE INDEX idx_events_name  ON events_raw (event, block_height);

CREATE TABLE indexer_cursor (
  name                    TEXT    PRIMARY KEY,
  contract_id             TEXT    NOT NULL,
  start_block_height      INTEGER NOT NULL,
  last_block_height       INTEGER NOT NULL,
  last_block_hash         TEXT    NOT NULL,
  last_block_timestamp_ns INTEGER NOT NULL,
  head_block_height       INTEGER NOT NULL,
  lag_blocks              INTEGER NOT NULL,
  rpc_endpoint            TEXT    NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE TABLE circles (
  circle_id   TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL UNIQUE,
  network     TEXT NOT NULL,
  CHECK (network = 'x207:' || circle_id)
);

CREATE TABLE members (
  circle_id        TEXT    NOT NULL REFERENCES circles(circle_id),
  account_id       TEXT    NOT NULL,
  pubkey_voucher   TEXT    NOT NULL,
  terms_hash       TEXT    NOT NULL,
  stake            INTEGER NOT NULL DEFAULT 0,
  credit_limit     INTEGER NOT NULL DEFAULT 0,
  outstanding_debt INTEGER NOT NULL DEFAULT 0,
  status           TEXT    NOT NULL CHECK (status IN ('pending','active','suspended','exited')),
  admitted         INTEGER NOT NULL DEFAULT 0,
  settled_history  INTEGER NOT NULL DEFAULT 0,
  joined_at_ns     INTEGER NOT NULL,
  exit_requested_epoch INTEGER,
  reactivate_epoch INTEGER,
  updated_block    INTEGER NOT NULL,
  PRIMARY KEY (circle_id, account_id)
);
CREATE INDEX idx_members_status ON members (circle_id, status);

CREATE TABLE member_limits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id     TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  epoch         INTEGER,
  old_limit     INTEGER NOT NULL,
  new_limit     INTEGER NOT NULL,
  status        TEXT    NOT NULL,
  reason        TEXT    NOT NULL CHECK (reason IN ('stake','finalize','default')),
  block_height  INTEGER NOT NULL,
  receipt_id    TEXT    NOT NULL,
  log_index     INTEGER NOT NULL,
  UNIQUE (receipt_id, log_index, account_id),
  FOREIGN KEY (circle_id, account_id) REFERENCES members(circle_id, account_id)
);
CREATE INDEX idx_limits_member ON member_limits (circle_id, account_id, id);

CREATE TABLE epochs (
  circle_id           TEXT    NOT NULL REFERENCES circles(circle_id),
  epoch               INTEGER NOT NULL,
  phase               TEXT    NOT NULL CHECK (phase IN ('open','clearing','payment_window','finalized')),
  cutoff_at_ns        INTEGER,
  closed_at_ns        INTEGER,
  proposal_deadline_ns INTEGER,
  committed_at_ns     INTEGER,
  payment_deadline_ns INTEGER,
  finalized_at_ns     INTEGER,
  edge_count          INTEGER,
  total_obligation    INTEGER,
  cleared_total       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (circle_id, epoch)
);
CREATE INDEX idx_epochs_phase ON epochs (circle_id, phase);

CREATE TABLE obligations (
  circle_id          TEXT    NOT NULL,
  epoch              INTEGER NOT NULL,
  debtor             TEXT    NOT NULL,
  creditor           TEXT    NOT NULL,
  seq                INTEGER NOT NULL,
  cumulative_amount  INTEGER NOT NULL,
  cleared            INTEGER,
  registration_mode  TEXT    NOT NULL CHECK (registration_mode IN ('cumulative','per_request')),
  registered_block   INTEGER NOT NULL,
  receipt_id         TEXT    NOT NULL,
  PRIMARY KEY (circle_id, epoch, debtor, creditor),
  FOREIGN KEY (circle_id, epoch) REFERENCES epochs(circle_id, epoch),
  CHECK (cleared IS NULL OR (cleared >= 0 AND cleared <= cumulative_amount))
);
CREATE INDEX idx_obl_creditor ON obligations (circle_id, epoch, creditor);
CREATE INDEX idx_obl_debtor   ON obligations (circle_id, debtor, epoch);

CREATE TABLE clearing_log (
  circle_id      TEXT    NOT NULL,
  epoch          INTEGER NOT NULL,
  solver         TEXT    NOT NULL,
  cleared_total  INTEGER NOT NULL,
  fee            INTEGER NOT NULL DEFAULT 0,
  edge_count     INTEGER NOT NULL,
  block_height   INTEGER NOT NULL,
  applied_at_ns  INTEGER NOT NULL,
  tx_hash        TEXT,
  receipt_id     TEXT    NOT NULL,
  PRIMARY KEY (circle_id, epoch),
  FOREIGN KEY (circle_id, epoch) REFERENCES epochs(circle_id, epoch)
);

CREATE TABLE settlements (
  circle_id      TEXT    NOT NULL,
  epoch          INTEGER NOT NULL,
  account_id     TEXT    NOT NULL,
  role           TEXT    NOT NULL CHECK (role IN ('debtor','creditor','none')),
  net            INTEGER NOT NULL,
  amount         INTEGER NOT NULL,
  cleared        INTEGER NOT NULL DEFAULT 0,
  status         TEXT    CHECK (status IS NULL OR status IN ('due','paid','defaulted','claimable','claimed')),
  due_at_ns      INTEGER,
  paid_amount    INTEGER NOT NULL DEFAULT 0,
  stake_slashed  INTEGER NOT NULL DEFAULT 0,
  reserve_used   INTEGER NOT NULL DEFAULT 0,
  shortfall      INTEGER NOT NULL DEFAULT 0,
  haircut        INTEGER NOT NULL DEFAULT 0,
  destination    TEXT CHECK (destination IS NULL OR destination IN ('near','intents')),
  tx_hash        TEXT,
  updated_block  INTEGER NOT NULL,
  PRIMARY KEY (circle_id, epoch, account_id),
  FOREIGN KEY (circle_id, epoch) REFERENCES epochs(circle_id, epoch),
  CHECK ((role = 'none' AND status IS NULL AND net = 0)
      OR (role = 'debtor'   AND net < 0 AND status IN ('due','paid','defaulted'))
      OR (role = 'creditor' AND net > 0 AND status IN ('claimable','claimed')))
);
CREATE INDEX idx_settle_account ON settlements (circle_id, account_id, epoch);
CREATE INDEX idx_settle_status  ON settlements (circle_id, epoch, status);

CREATE TABLE params (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id       TEXT    NOT NULL,
  field           TEXT    NOT NULL CHECK (field IN ('epoch_length','payment_window','proposal_window',
                    'base_limit_ratio','limit_growth','limit_cap','limit_decay','fees','admission')),
  old_value       TEXT,
  new_value       TEXT    NOT NULL,
  effective_epoch INTEGER NOT NULL,
  block_height    INTEGER NOT NULL,
  receipt_id      TEXT    NOT NULL,
  log_index       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (receipt_id, log_index, field)
);
CREATE INDEX idx_params_field ON params (circle_id, field, id);

CREATE VIEW params_active AS
SELECT p.circle_id, p.field, p.new_value AS value, p.effective_epoch
FROM params p
WHERE p.id = (SELECT MAX(id) FROM params q WHERE q.circle_id = p.circle_id AND q.field = p.field);

CREATE TABLE settlement_jobs (
  job_id            TEXT    PRIMARY KEY,
  kind              TEXT    NOT NULL CHECK (kind IN ('deposit_stake','deposit_settle','withdraw')),
  circle_id         TEXT    NOT NULL,
  account_id        TEXT    NOT NULL,
  epoch             INTEGER,
  origin_asset      TEXT    NOT NULL,
  destination_asset TEXT    NOT NULL,
  amount_in         TEXT,
  amount_out        TEXT,
  withdraw_fee      TEXT,
  deposit_address   TEXT,
  refund_to         TEXT    NOT NULL,
  recipient         TEXT    NOT NULL,
  recipient_type    TEXT    NOT NULL CHECK (recipient_type IN ('INTENTS','DESTINATION_CHAIN')),
  dry               INTEGER NOT NULL DEFAULT 1,
  one_click_status  TEXT,
  status            TEXT    NOT NULL CHECK (status IN ('quoted','awaiting_signature','waiting_deposit','processing',
                      'ready_withdraw','completed','failed','expired','refunded')),
  quote_json        TEXT    NOT NULL,
  intent_hash       TEXT,
  quote_deadline    INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_jobs_account ON settlement_jobs (account_id, created_at);
CREATE INDEX idx_jobs_status  ON settlement_jobs (status);
`;

/** BE-036: bundles committed on chain (event `bundle_committed`) and their legs. Amounts are TEXT decimal (U128). */
const V2_BUNDLES = `
CREATE TABLE bundles (
  circle_id    TEXT    NOT NULL REFERENCES circles (circle_id),
  bundle_id    INTEGER NOT NULL,
  terms_hash   TEXT    NOT NULL,
  epoch        INTEGER NOT NULL,
  solver       TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
  block_height INTEGER NOT NULL,
  receipt_id   TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  PRIMARY KEY (circle_id, bundle_id),
  UNIQUE (circle_id, terms_hash)
);
CREATE INDEX idx_bundles_epoch ON bundles (circle_id, epoch);
CREATE TABLE bundle_legs (
  circle_id  TEXT    NOT NULL,
  bundle_id  INTEGER NOT NULL,
  leg_index  INTEGER NOT NULL,
  payer      TEXT    NOT NULL,
  payee      TEXT    NOT NULL,
  max_amount TEXT    NOT NULL,
  PRIMARY KEY (circle_id, bundle_id, leg_index),
  FOREIGN KEY (circle_id, bundle_id) REFERENCES bundles (circle_id, bundle_id)
);
`;

/** BE-038 (F8): D10 registry and D11 grants as the events tell them; scope, quota and operator are read with the `get_grant` view. */
const V3_GRANTS = `
CREATE TABLE asset_classes (
  circle_id    TEXT    NOT NULL REFERENCES circles (circle_id),
  asset_type   TEXT    NOT NULL,
  class        TEXT    NOT NULL CHECK (class IN ('A','B','C','D','X')),
  block_height INTEGER NOT NULL,
  receipt_id   TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  PRIMARY KEY (circle_id, asset_type)
);
CREATE TABLE grants (
  circle_id       TEXT    NOT NULL REFERENCES circles (circle_id),
  grant_id        INTEGER NOT NULL,
  asset_type      TEXT    NOT NULL,
  grantor         TEXT    NOT NULL,
  grantee         TEXT,
  class           TEXT    NOT NULL CHECK (class IN ('A','B','C','D','X')),
  unit            TEXT    NOT NULL,
  unit_price      INTEGER NOT NULL,
  expires_at_ns   INTEGER NOT NULL,
  delivery_pubkey TEXT,
  status          TEXT    NOT NULL CHECK (status IN ('offered','active','revoked','expired')),
  revoke_reason   TEXT,
  block_height    INTEGER NOT NULL,
  receipt_id      TEXT    NOT NULL,
  log_index       INTEGER NOT NULL,
  PRIMARY KEY (circle_id, grant_id)
);
CREATE INDEX idx_grants_grantee ON grants (circle_id, grantee, status);
CREATE INDEX idx_grants_grantor ON grants (circle_id, grantor, status);
`;

/** CT-075 (F8 class A): the NFT that an escrow holds for a grant. State follows the events: held, delivered, cancelled, stuck. */
const V5_INTENTS = `
-- interface 0.0.9: the intents that members hash on chain (\`post_intent\`, \`remove_intent\`) and the withdrawals from Intents (\`withdraw_intents_balance\`).
CREATE TABLE intent_book (
  circle_id      TEXT    NOT NULL REFERENCES circles (circle_id),
  intent_hash    TEXT    NOT NULL,
  account_id     TEXT    NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('posted','removed')),
  posted_at_ns   INTEGER NOT NULL,
  block_height   INTEGER NOT NULL,
  receipt_id     TEXT    NOT NULL,
  log_index      INTEGER NOT NULL,
  removed_block_height INTEGER,
  PRIMARY KEY (circle_id, intent_hash)
);
CREATE INDEX idx_intent_book_account ON intent_book (circle_id, account_id, status);
CREATE TABLE intent_withdrawals (
  circle_id    TEXT    NOT NULL REFERENCES circles (circle_id),
  amount       INTEGER NOT NULL,
  block_height INTEGER NOT NULL,
  receipt_id   TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  PRIMARY KEY (circle_id, receipt_id, log_index)
);
`;

const V4_ESCROWS = `
CREATE TABLE escrows (
  circle_id    TEXT    NOT NULL REFERENCES circles (circle_id),
  grant_id     INTEGER NOT NULL,
  nft_contract TEXT    NOT NULL,
  token_id     TEXT    NOT NULL,
  state        TEXT    NOT NULL CHECK (state IN ('held','delivered','cancelled','stuck')),
  block_height INTEGER NOT NULL,
  receipt_id   TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  PRIMARY KEY (circle_id, grant_id)
);
`;

// interface 0.0.10 (CT-090): a class A escrow can hold an exact amount of a NEP-141 token. The table is rebuilt so that the NFT columns may be empty. `amount` is TEXT: a token with 18 decimals passes 2^63.
const V6_FT_ESCROWS = `
CREATE TABLE escrows_new (
  circle_id    TEXT    NOT NULL REFERENCES circles (circle_id),
  grant_id     INTEGER NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'nft' CHECK (kind IN ('nft','ft')),
  nft_contract TEXT,
  token_id     TEXT,
  ft_contract  TEXT,
  amount       TEXT,
  state        TEXT    NOT NULL CHECK (state IN ('held','delivered','cancelled','stuck')),
  block_height INTEGER NOT NULL,
  receipt_id   TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  PRIMARY KEY (circle_id, grant_id),
  CHECK ((kind = 'nft' AND nft_contract IS NOT NULL AND token_id IS NOT NULL AND ft_contract IS NULL AND amount IS NULL)
      OR (kind = 'ft' AND ft_contract IS NOT NULL AND amount IS NOT NULL AND nft_contract IS NULL AND token_id IS NULL))
);
INSERT INTO escrows_new (circle_id, grant_id, kind, nft_contract, token_id, state, block_height, receipt_id, log_index)
  SELECT circle_id, grant_id, 'nft', nft_contract, token_id, state, block_height, receipt_id, log_index FROM escrows;
DROP TABLE escrows;
ALTER TABLE escrows_new RENAME TO escrows;
`;

// interface 0.0.10 (CT-092): a class A escrow can hold an exact amount of one NEP-245 multi-token (`kind` mt: `mt_contract`, `token_id`, `amount`).
const V7_MT_ESCROWS = `
CREATE TABLE escrows_new (
  circle_id    TEXT    NOT NULL REFERENCES circles (circle_id),
  grant_id     INTEGER NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'nft' CHECK (kind IN ('nft','ft','mt')),
  nft_contract TEXT,
  token_id     TEXT,
  ft_contract  TEXT,
  mt_contract  TEXT,
  amount       TEXT,
  state        TEXT    NOT NULL CHECK (state IN ('held','delivered','cancelled','stuck')),
  block_height INTEGER NOT NULL,
  receipt_id   TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  PRIMARY KEY (circle_id, grant_id),
  CHECK ((kind = 'nft' AND nft_contract IS NOT NULL AND token_id IS NOT NULL AND ft_contract IS NULL AND mt_contract IS NULL AND amount IS NULL)
      OR (kind = 'ft' AND ft_contract IS NOT NULL AND amount IS NOT NULL AND nft_contract IS NULL AND token_id IS NULL AND mt_contract IS NULL)
      OR (kind = 'mt' AND mt_contract IS NOT NULL AND token_id IS NOT NULL AND amount IS NOT NULL AND nft_contract IS NULL AND ft_contract IS NULL))
);
INSERT INTO escrows_new (circle_id, grant_id, kind, nft_contract, token_id, ft_contract, amount, state, block_height, receipt_id, log_index)
  SELECT circle_id, grant_id, kind, nft_contract, token_id, ft_contract, amount, state, block_height, receipt_id, log_index FROM escrows;
DROP TABLE escrows;
ALTER TABLE escrows_new RENAME TO escrows;
`;

// BE-055: who signed the transaction and which method it called, as the block source knew them (empty when it did not). Read by the proofs of keeper and solver orders.
const V8_EVENT_CALLER = `
ALTER TABLE events_raw ADD COLUMN signer_id   TEXT;
ALTER TABLE events_raw ADD COLUMN method_name TEXT;
`;

// BE-065 (interface 0.0.12): the deals with a bond, the freezes of members and the official contracts per asset type, as the events tell them. `deals` is one row per bundle with a bond:
// the parties come from the two `bond_locked`, the dispute from `deal_disputed`, the arbiter from `deal_ruled`; `get_deal` of the contract adds the arbiter and `confirm_by` of a deal that is open.
const V9_RULES_0_0_12 = `
CREATE TABLE deals (
  circle_id       TEXT    NOT NULL REFERENCES circles(circle_id),
  bundle_id       INTEGER NOT NULL,
  party_a         TEXT    NOT NULL,
  party_b         TEXT,
  bond_each       INTEGER NOT NULL,
  locked_a        INTEGER NOT NULL DEFAULT 1,
  locked_b        INTEGER NOT NULL DEFAULT 0,
  state           TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open','disputed','closed')),
  complainant     TEXT,
  accused         TEXT,
  evidence_hash   TEXT,
  disputed_at_ns  INTEGER,
  arbiter         TEXT,
  verdict         TEXT,
  opened_block    INTEGER NOT NULL,
  closed_block    INTEGER,
  PRIMARY KEY (circle_id, bundle_id)
);
CREATE INDEX idx_deals_a ON deals (circle_id, party_a, state);
CREATE INDEX idx_deals_b ON deals (circle_id, party_b, state);
CREATE TABLE deal_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id     TEXT    NOT NULL,
  bundle_id     INTEGER NOT NULL,
  event         TEXT    NOT NULL,
  account_id    TEXT,
  amount        INTEGER,
  detail        TEXT,
  block_height  INTEGER NOT NULL,
  receipt_id    TEXT    NOT NULL,
  log_index     INTEGER NOT NULL,
  UNIQUE (receipt_id, log_index, event, account_id)
);
CREATE INDEX idx_deal_events ON deal_events (circle_id, bundle_id, id);
CREATE TABLE member_freezes (
  circle_id     TEXT    NOT NULL REFERENCES circles(circle_id),
  account_id    TEXT    NOT NULL,
  state         TEXT    NOT NULL CHECK (state IN ('pending','frozen')),
  eta_ns        INTEGER,
  reason_hash   TEXT,
  from_epoch    INTEGER,
  block_height  INTEGER NOT NULL,
  PRIMARY KEY (circle_id, account_id)
);
CREATE TABLE official_contracts (
  circle_id     TEXT    NOT NULL REFERENCES circles(circle_id),
  asset_type    TEXT    NOT NULL,
  contracts     TEXT    NOT NULL,
  block_height  INTEGER NOT NULL,
  PRIMARY KEY (circle_id, asset_type)
);
`;

// BE-065: the limit history has a new reason, `ruling` (the limit that `rule_deal` lowered). SQLite cannot change a CHECK, so the table is made again and copied.
const V10_LIMIT_REASON_RULING = `
CREATE TABLE member_limits_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id     TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  epoch         INTEGER,
  old_limit     INTEGER NOT NULL,
  new_limit     INTEGER NOT NULL,
  status        TEXT    NOT NULL,
  reason        TEXT    NOT NULL CHECK (reason IN ('stake','finalize','default','ruling')),
  block_height  INTEGER NOT NULL,
  receipt_id    TEXT    NOT NULL,
  log_index     INTEGER NOT NULL,
  UNIQUE (receipt_id, log_index, account_id),
  FOREIGN KEY (circle_id, account_id) REFERENCES members(circle_id, account_id)
);
INSERT INTO member_limits_new (id, circle_id, account_id, epoch, old_limit, new_limit, status, reason, block_height, receipt_id, log_index)
  SELECT id, circle_id, account_id, epoch, old_limit, new_limit, status, reason, block_height, receipt_id, log_index FROM member_limits;
DROP TABLE member_limits;
ALTER TABLE member_limits_new RENAME TO member_limits;
CREATE INDEX idx_limits_member ON member_limits (circle_id, account_id, id);
`;

// BE-077: the edges of an epoch read from the view `list_obligations` for a `clearing_applied` summary (interface 0.0.13). Not a read model table: a rebuild keeps it and replays from it, with no RPC.
const V11_CLEARING_EDGES = `
CREATE TABLE clearing_edges (
  circle_id    TEXT    NOT NULL,
  epoch        INTEGER NOT NULL,
  edges_json   TEXT    NOT NULL,
  edges_hash   TEXT    NOT NULL,
  block_height INTEGER NOT NULL,
  PRIMARY KEY (circle_id, epoch)
);
`;

// BE-077: the totals of `epoch_committed` of interface 0.0.13 (checked against the sum of the positions, kept per epoch).
const V12_EPOCH_TOTALS = `
ALTER TABLE epochs ADD COLUMN total_due INTEGER;
ALTER TABLE epochs ADD COLUMN total_claimable INTEGER;
`;

// B8-F1: an epoch whose cleared edges can no longer be read from the chain (`prune_epoch` removed the pairs before the indexer got to them) is marked, not a reason to stop the indexer.
const V13_EDGES_UNAVAILABLE = `
ALTER TABLE epochs ADD COLUMN edges_unavailable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clearing_edges ADD COLUMN unavailable INTEGER NOT NULL DEFAULT 0;
`;

// BE-081: the stake and the limit of a member after the fee of a commit are computed by the indexer, not read from an event. `stale` marks a member whose numbers could not be computed or were
// found different from the view `member` (and were taken from the view); `fee_mismatches` counts how many times.
const V14_MEMBER_STALE = `
ALTER TABLE members ADD COLUMN stale INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN fee_mismatches INTEGER NOT NULL DEFAULT 0;
`;

// BE-092: `get_params` of interface 0.0.13 has four more fields (names as the contract has them); `params.field` allowed only the first nine, and `INSERT OR IGNORE` dropped the others without a word.
// SQLite cannot change a CHECK, so the table is rebuilt with its rows, its index and the view.
const V15_PARAMS_FIELDS = `
DROP VIEW params_active;
ALTER TABLE params RENAME TO params_old;
DROP INDEX idx_params_field;
CREATE TABLE params (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id       TEXT    NOT NULL,
  field           TEXT    NOT NULL CHECK (field IN ('epoch_length','payment_window','proposal_window',
                    'base_limit_ratio','limit_growth','limit_cap','limit_decay','fees','admission',
                    'max_search_share_bps','bond_threshold','bond_bps','prune_delay_epochs')),
  old_value       TEXT,
  new_value       TEXT    NOT NULL,
  effective_epoch INTEGER NOT NULL,
  block_height    INTEGER NOT NULL,
  receipt_id      TEXT    NOT NULL,
  log_index       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (receipt_id, log_index, field)
);
INSERT INTO params (id, circle_id, field, old_value, new_value, effective_epoch, block_height, receipt_id, log_index)
  SELECT id, circle_id, field, old_value, new_value, effective_epoch, block_height, receipt_id, log_index FROM params_old;
DROP TABLE params_old;
CREATE INDEX idx_params_field ON params (circle_id, field, id);
CREATE VIEW params_active AS
SELECT p.circle_id, p.field, p.new_value AS value, p.effective_epoch
FROM params p
WHERE p.id = (SELECT MAX(id) FROM params q WHERE q.circle_id = p.circle_id AND q.field = p.field);
`;

/** BE-103: `relayer_fee` (DAO parameter of interface 0.0.16 and later) is a field of `params`; without it a `params_updated` that changes it would fail the CHECK and halt the indexer. */
const V16_PARAMS_RELAYER_FEE = `
DROP VIEW params_active;
ALTER TABLE params RENAME TO params_old;
DROP INDEX idx_params_field;
CREATE TABLE params (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id       TEXT    NOT NULL,
  field           TEXT    NOT NULL CHECK (field IN ('epoch_length','payment_window','proposal_window',
                    'base_limit_ratio','limit_growth','limit_cap','limit_decay','fees','admission',
                    'max_search_share_bps','bond_threshold','bond_bps','prune_delay_epochs','relayer_fee')),
  old_value       TEXT,
  new_value       TEXT    NOT NULL,
  effective_epoch INTEGER NOT NULL,
  block_height    INTEGER NOT NULL,
  receipt_id      TEXT    NOT NULL,
  log_index       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (receipt_id, log_index, field)
);
INSERT INTO params (id, circle_id, field, old_value, new_value, effective_epoch, block_height, receipt_id, log_index)
  SELECT id, circle_id, field, old_value, new_value, effective_epoch, block_height, receipt_id, log_index FROM params_old;
DROP TABLE params_old;
CREATE INDEX idx_params_field ON params (circle_id, field, id);
CREATE VIEW params_active AS
SELECT p.circle_id, p.field, p.new_value AS value, p.effective_epoch
FROM params p
WHERE p.id = (SELECT MAX(id) FROM params q WHERE q.circle_id = p.circle_id AND q.field = p.field);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "d9_initial", sql: V1_D9_INITIAL },
  { version: 2, name: "d9_bundles", sql: V2_BUNDLES },
  { version: 3, name: "d9_grants", sql: V3_GRANTS },
  { version: 4, name: "d9_escrows", sql: V4_ESCROWS },
  { version: 5, name: "d9_intents", sql: V5_INTENTS },
  { version: 6, name: "d9_ft_escrows", sql: V6_FT_ESCROWS },
  { version: 7, name: "d9_mt_escrows", sql: V7_MT_ESCROWS },
  { version: 8, name: "d9_event_caller", sql: V8_EVENT_CALLER },
  { version: 9, name: "d9_rules_0_0_12", sql: V9_RULES_0_0_12 },
  { version: 10, name: "d9_limit_reason_ruling", sql: V10_LIMIT_REASON_RULING },
  { version: 11, name: "d9_clearing_edges", sql: V11_CLEARING_EDGES },
  { version: 12, name: "d9_epoch_totals", sql: V12_EPOCH_TOTALS },
  { version: 13, name: "d9_edges_unavailable", sql: V13_EDGES_UNAVAILABLE },
  { version: 14, name: "d9_member_stale", sql: V14_MEMBER_STALE },
  { version: 15, name: "d9_params_fields", sql: V15_PARAMS_FIELDS },
  { version: 16, name: "d9_params_relayer_fee", sql: V16_PARAMS_RELAYER_FEE },
];
