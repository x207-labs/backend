import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { backupDatabase, checkDatabase, restoreDatabase } from "../../src/db/backup.js";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { marketplaceRoutes } from "../../src/marketplace/index.js";
import { ArrayBlockSource, CONTRACT, fxLog42 } from "../helpers/fx-log42.js";

const CIRCLE = "agents-main";
const START = 1000;
const BLOCKS = fxLog42();
const LAST = Math.max(...BLOCKS.map((b) => b.height));
const dir = mkdtempSync(join(tmpdir(), "x207-backup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Every table of the file, rows in a fixed order, bigints as text. */
function snapshot(file: string): Record<string, unknown[]> {
  const db = new Database(file, { readonly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    return Object.fromEntries(names.filter((n) => n !== "schema_migrations").map((n) => [n, db.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).safeIntegers(true).all().map((r) => JSON.parse(JSON.stringify(r, (k, v) => (k === "updated_at" ? undefined : typeof v === "bigint" ? v.toString() : v))))]));
  } finally {
    db.close();
  }
}

/** A database that looks like a live one: D9 filled by the indexer up to `upTo`, the marketplace tables made, and a row in a few of them. */
async function makeLive(file: string, upTo: number) {
  const db = openDatabase(file);
  marketplaceRoutes(db); // the migrations of the marketplace
  const ix = new Indexer({ db, source: new ArrayBlockSource(BLOCKS.filter((b) => b.height <= upTo), upTo), circleId: CIRCLE, contractId: CONTRACT, startBlock: START });
  await ix.bootstrap();
  await ix.drain();
  return { db, ix };
}

describe("BE-073 backup and restore of the SQLite file", () => {
  it("TC-BE-073-01 a backup taken while the process keeps writing is a consistent, healthy database that this build can open", async () => {
    const file = join(dir, "live.db");
    const { db } = await makeLive(file, LAST);
    db.exec("CREATE TABLE IF NOT EXISTS busy (n INTEGER PRIMARY KEY, pad TEXT)");
    let stop = false;
    const writer = (async () => {
      for (let n = 0; !stop; n++) {
        db.prepare("INSERT INTO busy (n, pad) VALUES (?, ?)").run(n, "x".repeat(2000));
        if (n % 20 === 0) await new Promise((r) => setImmediate(r));
      }
    })();
    const dest = join(dir, "live.backup.db");
    const check = await backupDatabase(db, dest);
    stop = true;
    await writer;
    expect(check).toMatchObject({ ok: true, problems: [], unknownVersions: [], pendingVersions: [] });
    expect(check.migrations.d9).toBe(14);
    expect(check.migrations.marketplace).toBeGreaterThanOrEqual(1116);
    expect(check.cursors).toEqual([{ name: CONTRACT, lastBlockHeight: LAST }]);
    expect(existsSync(`${dest}.partial`)).toBe(false);
    // it opens with the code of this build and runs no migration
    const copy = openDatabase(dest);
    expect(copy.prepare("SELECT COUNT(*) AS n FROM members").get()).toMatchObject({ n: 6 });
    const rows = (copy.prepare("SELECT COUNT(*) AS n FROM busy").get() as { n: number }).n;
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual((db.prepare("SELECT COUNT(*) AS n FROM busy").get() as { n: number }).n);
    copy.close();
    db.close();
    // it does not overwrite a backup that exists
    await expect(backupDatabase(file, dest)).rejects.toThrow(/already exists/);
  });

  it("TC-BE-073-02 RESTORE for real: the file is lost, the backup is put back, the tables are the same, and the indexer goes on from the cursor to the state of a run that never stopped", async () => {
    const halfWay = START + 5;
    const live = join(dir, "prod.db");
    const { db } = await makeLive(live, halfWay);
    // rows in tables that the chain cannot give back: they exist only in this file
    db.prepare("INSERT INTO code_checks (circle_id, listing_hash, verdict, checked_at_ms) VALUES (?, ?, 'valid', 1)").run(CIRCLE, "a".repeat(64));
    db.prepare("INSERT INTO code_seen (circle_id, mac, listing_hash, seen_at_ms) VALUES (?, ?, ?, 1)").run(CIRCLE, "b".repeat(64), "a".repeat(64));
    const before = snapshot(live);
    const backup = join(dir, "prod.backup.db");
    await backupDatabase(db, backup);
    db.close();

    // the disaster: the file and its log are gone
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${live}${suffix}`, { force: true });
    expect(existsSync(live)).toBe(false);

    const restored = restoreDatabase(backup, live);
    expect(restored).toMatchObject({ ok: true });
    expect(snapshot(live)).toEqual(before);

    // the process starts again on the restored file: nothing migrates, the cursor is where the backup was, and the rest of the chain is read
    const db2 = openDatabase(live);
    const after = db2.prepare("SELECT last_block_height AS h FROM indexer_cursor").get() as { h: number };
    expect(after.h).toBe(halfWay);
    const ix = new Indexer({ db: db2, source: new ArrayBlockSource(BLOCKS, LAST), circleId: CIRCLE, contractId: CONTRACT, startBlock: START });
    await ix.bootstrap();
    await ix.drain();
    db2.close();

    const clean = join(dir, "never-stopped.db");
    const { db: db3 } = await makeLive(clean, LAST);
    db3.prepare("INSERT INTO code_checks (circle_id, listing_hash, verdict, checked_at_ms) VALUES (?, ?, 'valid', 1)").run(CIRCLE, "a".repeat(64));
    db3.prepare("INSERT INTO code_seen (circle_id, mac, listing_hash, seen_at_ms) VALUES (?, ?, ?, 1)").run(CIRCLE, "b".repeat(64), "a".repeat(64));
    db3.close();
    expect(snapshot(live)).toEqual(snapshot(clean));
  });

  it("TC-BE-073-03 restore is refused for a copy that is cut short, damaged, from a newer build or missing; a file already there is not replaced without force; the file in place is untouched by a refusal", async () => {
    const file = join(dir, "r.db");
    const { db } = await makeLive(file, LAST);
    const good = join(dir, "r.backup.db");
    await backupDatabase(db, good);
    db.close();
    const inPlace = join(dir, "inplace.db");
    writeFileSync(inPlace, "not a database, but the owner's file");

    // already there
    expect(() => restoreDatabase(good, inPlace)).toThrow(/already exists/);
    // cut short
    const cut = join(dir, "cut.db");
    writeFileSync(cut, Buffer.from(Buffer.from(readFileSync(good)).subarray(0, 5000)));
    expect(checkDatabase(cut), "cut").toMatchObject({ ok: false });
    expect(() => restoreDatabase(cut, inPlace, { force: true })).toThrow(/unhealthy copy/);
    // damaged in the middle
    const damaged = join(dir, "damaged.db");
    const bytes = Buffer.from(readFileSync(good));
    for (let i = 8192; i < Math.min(bytes.length, 8192 + 4096); i++) bytes[i] = 0xff;
    writeFileSync(damaged, bytes);
    expect(checkDatabase(damaged), "damaged").toMatchObject({ ok: false });
    expect(() => restoreDatabase(damaged, inPlace, { force: true })).toThrow(/unhealthy copy/);
    // from a newer build
    const newer = join(dir, "newer.db");
    await backupDatabase(good, newer);
    const n = new Database(newer);
    n.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, 'from_the_future', 1)").run();
    n.close();
    const verdict = checkDatabase(newer);
    expect(verdict).toMatchObject({ ok: false, unknownVersions: [9999] });
    expect(() => restoreDatabase(newer, inPlace, { force: true })).toThrow(/unknown to this build/);
    // missing
    expect(checkDatabase(join(dir, "nope.db")).ok).toBe(false);
    // none of the refusals touched the file in place
    expect(readFileSync(inPlace, "utf8")).toBe("not a database, but the owner's file");
    // with force a healthy copy replaces it, and a leftover log of the old file is gone
    writeFileSync(`${inPlace}-wal`, "stale log");
    restoreDatabase(good, inPlace, { force: true });
    // the log of the old file is not replayed (a read-only open of a WAL file may leave an empty log of its own)
    expect(!existsSync(`${inPlace}-wal`) || readFileSync(`${inPlace}-wal`, "utf8") !== "stale log").toBe(true);
    expect(checkDatabase(inPlace).ok).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".partial") || f.endsWith(".restoring"))).toEqual([]);
  });

  it("TC-BE-073-05 a file from an OLDER build is healthy and lists the migrations the next start would apply", async () => {
    const file = join(dir, "older.db");
    const { db } = await makeLive(file, LAST);
    db.prepare("DELETE FROM schema_migrations WHERE version IN (14, 1118)").run(); // as if the file was written before them
    db.close();
    expect(checkDatabase(file)).toMatchObject({ ok: true, unknownVersions: [], pendingVersions: [14, 1118], migrations: { d9: 13, marketplace: 1117 } });
  });

  const dist = new URL("../../dist/db/backup.js", import.meta.url).pathname;
  it.skipIf(!existsSync(dist))("TC-BE-073-04 the command line: backup, check and restore as an operator runs them, with exit codes", async () => {
    const file = join(dir, "cli.db");
    const { db } = await makeLive(file, LAST);
    db.close();
    const cli = new URL("../../scripts/db-backup.mjs", import.meta.url).pathname;
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    const backup = join(dir, "cli.backup.db");
    const made = run("backup", file, backup);
    expect([made.status, JSON.parse(made.stdout).ok]).toEqual([0, true]);
    expect(run("backup", file, backup).status).toBe(1); // does not overwrite
    expect(run("check", backup).status).toBe(0);
    const bad = join(dir, "cli.bad.db");
    writeFileSync(bad, "garbage");
    expect(run("check", bad).status).toBe(1);
    rmSync(file);
    const restored = run("restore", backup, file);
    expect([restored.status, JSON.parse(restored.stdout).ok]).toEqual([0, true]);
    expect(run("restore", backup, file).status).toBe(1); // exists, no --force
    expect(run("restore", backup, file, "--force").status).toBe(0);
    expect(run().status).toBe(2);
  });
});
