import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { migrate, SchemaTooNewError } from "../../src/db/migrate.js";
import { openDatabase } from "../../src/db/index.js";
import { marketplaceRoutes } from "../../src/marketplace/index.js";

const dir = mkdtempSync(join(tmpdir(), "x207-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A file as a NEWER build leaves it: this build's migrations, and one that this build does not have. */
function newerFile(name: string, extra: number[] = [9999]): string {
  const file = join(dir, name);
  const db = openDatabase(file);
  marketplaceRoutes(db);
  for (const v of extra) db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'from_a_newer_build', 1)").run(v);
  db.close();
  return file;
}
const recorded = (file: string): number => {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("BE-073 fix: the start guard refuses a file written by a newer build", () => {
  it("TC-BE-073-06 migrate and openDatabase refuse a file with a migration this build does not have; the message names the versions of the file and of the code; nothing is changed in the file", () => {
    const file = newerFile("newer.db", [1121, 9999]);
    const before = recorded(file);
    let error: unknown;
    try {
      openDatabase(file);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SchemaTooNewError);
    const message = (error as SchemaTooNewError).message;
    expect(message).toContain("1121, 9999");
    expect(message).toMatch(/highest version in database: D9 17, marketplace 9999; in code: D9 17, marketplace 1120/);
    expect((error as SchemaTooNewError).unknown).toEqual([1121, 9999]);
    expect(recorded(file)).toBe(before);
    const db = new Database(file);
    expect(() => migrate(db)).toThrow(SchemaTooNewError);
    expect(() => marketplaceRoutes(db)).toThrow(SchemaTooNewError);
    db.close();
  });

  it("TC-BE-073-07 a file from an OLDER build still migrates forward, and a file of this build opens as before", () => {
    const file = join(dir, "older.db");
    const db = openDatabase(file);
    marketplaceRoutes(db);
    db.prepare("DELETE FROM schema_migrations WHERE version IN (10, 1116)").run();
    db.exec("DROP TABLE purchase_complaints");
    db.close();
    const again = openDatabase(file);
    expect(marketplaceRoutes(again).length).toBeGreaterThan(0);
    expect(again.prepare("SELECT COUNT(*) AS n FROM purchase_complaints").get()).toMatchObject({ n: 0 });
    again.close();
    expect(() => openDatabase(file)).not.toThrow();
  });

  const dist = new URL("../../dist/main.js", import.meta.url).pathname;
  it.skipIf(!existsSync(dist))("TC-BE-073-08 the process started on such a file ends with a code that is not 0 and one JSON line that says why, before it opens a port or asks the RPC", () => {
    const file = newerFile("proc.db");
    const run = spawnSync(process.execPath, [dist], {
      encoding: "utf8", timeout: 30_000,
      env: { PATH: process.env.PATH ?? "", X207_DB_PATH: file, NEAR_RPC_PRIMARY_URL: "http://127.0.0.1:9", X207_CONTRACT_ID: "c.near", X207_START_BLOCK: "1", X207_API_PORT: "0" },
    });
    expect(run.status).toBe(1);
    const line = JSON.parse(run.stderr.trim().split("\n").pop()!);
    expect(line).toMatchObject({ level: "error", msg: "backend failed to start", error: { name: "SchemaTooNewError" } });
    expect(line.error.message).toContain("9999");
    expect(recorded(file)).toBeGreaterThan(0);
  });
});
