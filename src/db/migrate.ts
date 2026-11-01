import Database from "better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations.js";

/** Terapkan migrasi yang belum tercatat di `schema_migrations`; aman dipanggil berulang. */
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): number[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map((r) => r.version),
  );
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

/** Buka (atau buat) basis data D9: WAL, kunci asing aktif, lalu migrasi. */
export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
