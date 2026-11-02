/** Satu langkah migrasi. `version` naik satu per langkah dan tidak pernah diubah setelah dirilis. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * DDL mengikuti Spec Skema D9 bagian 3 (vault `04 Arsitektur/x207 - Spec Skema D9`).
 * Jumlah on-chain disimpan INTEGER (6 desimal); jumlah 1Click di `settlement_jobs` TEXT.
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

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "d9_initial", sql: V1_D9_INITIAL },
  { version: 2, name: "d9_bundles", sql: V2_BUNDLES },
];
