import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("BE-003 scaffold", () => {
  it.each([
    "src/indexer",
    "src/api",
    "src/report207",
    "src/settlement/deposit",
    "src/settlement/withdraw",
    "src/settlement/claims",
    "src/db",
  ])("folder %s ada", (folder) => {
    expect(existsSync(fileURLToPath(new URL(`../${folder}`, import.meta.url)))).toBe(true);
  });

  it("dependensi SQLite bisa dimuat", () => {
    const db = new Database(":memory:");
    expect(db.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
    db.close();
  });
});
