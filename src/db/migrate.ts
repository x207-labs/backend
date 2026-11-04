import Database from "better-sqlite3";
import { MARKETPLACE_MIGRATIONS } from "../marketplace/migrations.js";
import { MIGRATIONS, type Migration } from "./migrations.js";

/** The file has migrations that this build does not have: it was written by a NEWER build (BE-073). Migrations only go forward, so an older build must not run on it. */
export class SchemaTooNewError extends Error {
  constructor(readonly unknown: number[], readonly inDatabase: { d9: number | null; marketplace: number | null }, readonly inCode: { d9: number; marketplace: number }) {
    super(
      `database has migrations ${unknown.join(", ")} unknown to this build (highest version in database: D9 ${inDatabase.d9 ?? "-"}, marketplace ${inDatabase.marketplace ?? "-"}; in code: D9 ${inCode.d9}, marketplace ${inCode.marketplace}). ` +
        "Do not run an older build on this file: restore a backup from before the upgrade (docs/operations.md), or use the newer build.",
    );
    this.name = "SchemaTooNewError";
  }
}

const highest = (versions: readonly number[], pick: (v: number) => boolean): number | null => {
  const some = versions.filter(pick);
  return some.length === 0 ? null : Math.max(...some);
};

/** Apply migrations not yet recorded in `schema_migrations`; safe to call repeatedly. */
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
  // the start guard: a version recorded in the file that no migration of this build has (D9, marketplace, or the list given) is a file from a newer build
  const known = new Set([...MIGRATIONS, ...MARKETPLACE_MIGRATIONS, ...migrations].map((m) => m.version));
  const unknown = [...applied].filter((v) => !known.has(v)).sort((a, b) => a - b);
  if (unknown.length > 0) {
    throw new SchemaTooNewError(
      unknown,
      { d9: highest([...applied], (v) => v < 1000), marketplace: highest([...applied], (v) => v >= 1100) },
      { d9: highest([...known], (v) => v < 1000) ?? 0, marketplace: highest([...known], (v) => v >= 1100) ?? 0 },
    );
  }
  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  const done: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, Date.now());
    })();
    done.push(m.version);
  }
  return done;
}

/** Open (or create) the D9 database: WAL, foreign keys on, then migrations. */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
