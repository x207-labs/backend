import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../../src/db/migrate.js";
import { MIGRATIONS } from "../../src/db/migrations.js";

type Db = Database.Database;

const CIRCLE = "agents-main";

function names(db: Db, type: "table" | "view" | "index"): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all(type) as { name: string }[];
  return rows.map((r) => r.name);
}

function schemaSnapshot(db: Db): unknown {
  return db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
}

function addCircle(db: Db): void {
  db.prepare("INSERT INTO circles (circle_id, contract_id, network) VALUES (?, ?, ?)").run(
    CIRCLE,
    "x207-circle.near",
    `x207:${CIRCLE}`,
  );
}

function addMember(db: Db, account: string, status = "active"): void {
  db.prepare(
    `INSERT INTO members (circle_id, account_id, pubkey_voucher, terms_hash, status, joined_at_ns, updated_block)
     VALUES (?, ?, 'ed25519:abc', 'hash', ?, 1, 1)`,
  ).run(CIRCLE, account, status);
}

function addEpoch(db: Db, epoch = 1): void {
  db.prepare("INSERT INTO epochs (circle_id, epoch, phase) VALUES (?, ?, 'open')").run(CIRCLE, epoch);
}

describe("BE-004 migrasi skema D9", () => {
  let db: Db;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x207-d9-"));
    db = openDatabase(join(dir, "d9.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("TC-BE-004-01 semua tabel, view, dan indeks dibuat", () => {
    expect(names(db, "table")).toEqual(
      expect.arrayContaining([
        "circles",
        "clearing_log",
        "epochs",
        "events_raw",
        "indexer_cursor",
        "member_limits",
        "members",
        "obligations",
        "params",
        "settlement_jobs",
        "settlements",
      ]),
    );
    expect(names(db, "view")).toEqual(["params_active"]);
    expect(names(db, "index")).toEqual(
      expect.arrayContaining([
        "idx_events_block",
        "idx_events_name",
        "idx_members_status",
        "idx_limits_member",
        "idx_epochs_phase",
        "idx_obl_creditor",
        "idx_obl_debtor",
        "idx_settle_account",
        "idx_settle_status",
        "idx_params_field",
        "idx_jobs_account",
        "idx_jobs_status",
      ]),
    );
  });

  it("TC-BE-004-02 migrasi dua kali tidak error dan skema tidak berubah", () => {
    const before = schemaSnapshot(db);
    expect(() => migrate(db)).not.toThrow();
    expect(schemaSnapshot(db)).toEqual(before);
    const versions = db.prepare("SELECT version FROM schema_migrations").all();
    expect(versions).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }]);
  });

  it("TC-BE-004-03 kunci unik events_raw per (receipt_id, log_index)", () => {
    const insert = (verb: string) =>
      db.prepare(
        `INSERT ${verb} INTO events_raw
         (receipt_id, log_index, block_height, block_hash, block_timestamp_ns, contract_id, standard, version, event, data_json)
         VALUES ('r1', 0, 10, 'bh', 1, 'x207-circle.near', 'x207', '0.0.1', 'member_joined', '[]')`,
      );
    expect(insert("OR ABORT").run().changes).toBe(1);
    expect(() => insert("OR ABORT").run()).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(insert("OR IGNORE").run().changes).toBe(0);
  });

  it("TC-BE-004-04 status anggota mengikuti ADR-26", () => {
    addCircle(db);
    for (const status of ["pending", "active", "suspended", "exited"]) {
      expect(() => addMember(db, `${status}.near`, status)).not.toThrow();
    }
    expect(() => addMember(db, "banned.near", "banned")).toThrow(/CHECK/);
  });

  it("TC-BE-004-05 status settlement dan konsistensi peran", () => {
    addCircle(db);
    addEpoch(db);
    const insert = (account: string, role: string, net: number, status: string | null) =>
      db
        .prepare(
          `INSERT INTO settlements (circle_id, epoch, account_id, role, net, amount, status, updated_block)
           VALUES (?, 1, ?, ?, ?, ?, ?, 1)`,
        )
        .run(CIRCLE, account, role, net, Math.abs(net), status);
    expect(() => insert("a.near", "debtor", -1, "due")).not.toThrow();
    expect(() => insert("b.near", "creditor", 1, "claimable")).not.toThrow();
    expect(() => insert("c.near", "none", 0, null)).not.toThrow();
    expect(() => insert("d.near", "debtor", 1, "due")).toThrow(/CHECK/);
    expect(() => insert("e.near", "creditor", 1, "paid")).toThrow(/CHECK/);
  });

  it("TC-BE-004-05b semua nama status settlement ADR-26 diterima pada peran yang sesuai", () => {
    addCircle(db);
    addEpoch(db);
    const insert = (account: string, role: string, net: number, status: string) =>
      db
        .prepare(
          `INSERT INTO settlements (circle_id, epoch, account_id, role, net, amount, status, updated_block)
           VALUES (?, 1, ?, ?, ?, ?, ?, 1)`,
        )
        .run(CIRCLE, account, role, net, Math.abs(net), status);
    for (const status of ["due", "paid", "defaulted"]) insert(`${status}.near`, "debtor", -5, status);
    for (const status of ["claimable", "claimed"]) insert(`${status}.near`, "creditor", 5, status);
    expect(() => insert("x.near", "debtor", -5, "unknown")).toThrow(/CHECK/);
  });

  it("TC-BE-004-06 batas cleared di obligations", () => {
    addCircle(db);
    addEpoch(db);
    const insert = (n: number, cleared: number | null) =>
      db
        .prepare(
          `INSERT INTO obligations
           (circle_id, epoch, debtor, creditor, seq, cumulative_amount, cleared, registration_mode, registered_block, receipt_id)
           VALUES (?, 1, ?, 'c.near', 1, 100, ?, 'cumulative', 1, 'r')`,
        )
        .run(CIRCLE, `d${n}.near`, cleared);
    expect(() => insert(1, 101)).toThrow(/CHECK/);
    expect(() => insert(2, -1)).toThrow(/CHECK/);
    expect(() => insert(3, null)).not.toThrow();
    expect(() => insert(4, 0)).not.toThrow();
    expect(() => insert(5, 100)).not.toThrow();
  });

  it("TC-BE-004-07 params.field memuat field ADR-26", () => {
    addCircle(db);
    const insert = (field: string, i: number) =>
      db
        .prepare(
          `INSERT INTO params (circle_id, field, new_value, effective_epoch, block_height, receipt_id, log_index)
           VALUES (?, ?, '1', 1, 1, ?, 0)`,
        )
        .run(CIRCLE, field, `r${i}`);
    expect(() => insert("proposal_window", 1)).not.toThrow();
    expect(() => insert("limit_cap", 2)).not.toThrow();
    expect(() => insert("limit_decay", 3)).not.toThrow();
    expect(() => insert("foo", 4)).toThrow(/CHECK/);
  });

  it("TC-BE-004-07b view params_active memuat nilai terakhir per field", () => {
    addCircle(db);
    const insert = (value: string, receipt: string) =>
      db
        .prepare(
          `INSERT INTO params (circle_id, field, old_value, new_value, effective_epoch, block_height, receipt_id)
           VALUES (?, 'limit_cap', NULL, ?, 1, 1, ?)`,
        )
        .run(CIRCLE, value, receipt);
    insert("100", "init:1");
    insert("200", "r2");
    expect(db.prepare("SELECT field, value FROM params_active").all()).toEqual([
      { field: "limit_cap", value: "200" },
    ]);
  });

  it("TC-BE-004-08 circles.network konsisten dengan circle_id", () => {
    const insert = (network: string) =>
      db.prepare("INSERT INTO circles (circle_id, contract_id, network) VALUES (?, 'x207-circle.near', ?)").run(
        CIRCLE,
        network,
      );
    expect(() => insert("x207:other")).toThrow(/CHECK/);
    expect(() => insert(`x207:${CIRCLE}`)).not.toThrow();
  });

  it("TC-BE-004-09 setiap kolom read model terlacak ke field D1/D2/D4/D5/D7 atau teknis", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../docs/d9-column-mapping.md", import.meta.url)), "utf8");
    const mapping = new Map<string, string>();
    for (const line of doc.split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      // | tabel | kolom | field D | catatan |
      const [, table, column, fieldD] = cells;
      if (!table || !column || !fieldD || !/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) continue;
      mapping.set(`${table}.${column}`, fieldD.replace(/`/g, ""));
    }

    const readModel = ["circles", "members", "member_limits", "epochs", "obligations", "clearing_log", "settlements", "params"];
    const actual = new Set<string>();
    for (const table of readModel) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      for (const col of cols) actual.add(`${table}.${col.name}`);
    }

    for (const key of actual) {
      const fieldD = mapping.get(key);
      expect(fieldD, `kolom ${key} tidak ada di docs/d9-column-mapping.md`).toBeDefined();
      expect(fieldD, `kolom ${key} tanpa field D`).toMatch(/^(D[1-7]\b|teknis)/);
    }
    for (const key of mapping.keys()) {
      expect(actual.has(key), `docs memuat kolom ${key} yang tidak ada di skema`).toBe(true);
    }
    expect(mapping.get("members.terms_hash")).toMatch(/^D1/);
    expect(mapping.get("members.exit_requested_epoch")).toMatch(/^D1/);
  });

  it("TC-BE-004-10 status job 1Click", () => {
    const statuses = [
      "quoted",
      "awaiting_signature",
      "waiting_deposit",
      "processing",
      "ready_withdraw",
      "completed",
      "failed",
      "expired",
      "refunded",
    ];
    const insert = (id: string, status: string) =>
      db
        .prepare(
          `INSERT INTO settlement_jobs
           (job_id, kind, circle_id, account_id, origin_asset, destination_asset, refund_to, recipient,
            recipient_type, status, quote_json, created_at, updated_at)
           VALUES (?, 'deposit_stake', ?, 'a.near', 'o', 'd', 'a.near', 'a.near', 'INTENTS', ?, '{}', 1, 1)`,
        )
        .run(id, CIRCLE, status);
    statuses.forEach((s, i) => expect(() => insert(`j${i}`, s)).not.toThrow());
    expect(statuses).toHaveLength(9);
    expect(() => insert("jx", "done")).toThrow(/CHECK/);
  });

  it("TC-BE-004-11 mode WAL", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    const reopened = new Database(join(dir, "d9.db"));
    expect(reopened.pragma("journal_mode", { simple: true })).toBe("wal");
    reopened.close();
  });

  it("kunci asing aktif: member tanpa circle ditolak", () => {
    expect(() => addMember(db, "a.near")).toThrow(/FOREIGN KEY/);
  });
});

describe("BE-065 migration 10: the limit history keeps its rows and learns the reason ruling", () => {
  it("TC-BE-065-M1 rows written before the migration stay, a ruling can be written after, an unknown reason is still refused", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, MIGRATIONS.filter((m) => m.version < 10));
    db.prepare("INSERT INTO circles (circle_id, contract_id, network) VALUES ('c', 'c.near', 'x207:c')").run();
    db.prepare("INSERT INTO members (circle_id, account_id, pubkey_voucher, terms_hash, status, joined_at_ns, updated_block) VALUES ('c', 'a.near', 'k', 't', 'active', 1, 1)").run();
    db.prepare("INSERT INTO member_limits (circle_id, account_id, epoch, old_limit, new_limit, status, reason, block_height, receipt_id, log_index) VALUES ('c', 'a.near', 1, 0, 80, 'active', 'stake', 5, 'r1', 0)").run();
    expect(migrate(db)).toEqual([10, 11, 12]);
    expect(db.prepare("SELECT id, old_limit, new_limit, reason FROM member_limits").all()).toEqual([{ id: 1, old_limit: 0, new_limit: 80, reason: "stake" }]);
    db.prepare("INSERT INTO member_limits (circle_id, account_id, epoch, old_limit, new_limit, status, reason, block_height, receipt_id, log_index) VALUES ('c', 'a.near', 1, 80, 70, 'active', 'ruling', 6, 'r2', 0)").run();
    expect(() => db.prepare("INSERT INTO member_limits (circle_id, account_id, epoch, old_limit, new_limit, status, reason, block_height, receipt_id, log_index) VALUES ('c', 'a.near', 1, 70, 60, 'active', 'other', 7, 'r3', 0)").run()).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_limits_member'").all()).toHaveLength(1);
    db.close();
  });
});
