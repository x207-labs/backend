// Backup and restore of the SQLite file of the backend (BE-073). `backupDatabase` uses the online backup of SQLite (`better-sqlite3` `db.backup`): a consistent copy while the process writes,
// which a plain `cp` of a file in WAL mode is not. `restoreDatabase` checks the copy before it puts it in place: `PRAGMA integrity_check`, the tables that the code needs, and that no migration is
// recorded that this build does not know (a copy from a NEWER build must not be opened by an older one: the migrations only go forward).
import { copyFileSync, existsSync, renameSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";
import { MARKETPLACE_MIGRATIONS } from "../marketplace/migrations.js";

export const KNOWN_MIGRATIONS: readonly number[] = [...MIGRATIONS, ...MARKETPLACE_MIGRATIONS].map((m) => m.version);

export interface DatabaseCheck {
  ok: boolean;
  problems: string[];
  /** Highest recorded migration of each series: D9 (below 1000) and marketplace (1100 and up). */
  migrations: { d9: number | null; marketplace: number | null };
  /** Recorded migrations that this build does not have. */
  unknownVersions: number[];
  /** Migrations that this build has and the file does not: what the next start would apply. */
  pendingVersions: number[];
  cursors: Array<{ name: string; lastBlockHeight: number }>;
}

/** Opens `path` read-only and says whether it is a healthy copy for THIS build. Never changes the file. */
export function checkDatabase(path: string): DatabaseCheck {
  const result: DatabaseCheck = { ok: true, problems: [], migrations: { d9: null, marketplace: null }, unknownVersions: [], pendingVersions: [], cursors: [] };
  if (!existsSync(path)) return { ...result, ok: false, problems: [`${path} tidak ada`] };
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") result.problems.push(`integrity_check: ${integrity.map((r) => r.integrity_check).slice(0, 3).join("; ")}`);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
    for (const t of ["schema_migrations", "events_raw", "indexer_cursor", "members"]) if (!tables.has(t)) result.problems.push(`tabel ${t} tidak ada`);
    if (tables.has("schema_migrations")) {
      const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((r) => r.version);
      result.unknownVersions = versions.filter((v) => !KNOWN_MIGRATIONS.includes(v));
      result.pendingVersions = KNOWN_MIGRATIONS.filter((v) => !versions.includes(v)).sort((a, b) => a - b);
      const d9 = versions.filter((v) => v < 1000);
      const market = versions.filter((v) => v >= 1100);
      result.migrations = { d9: d9.length ? Math.max(...d9) : null, marketplace: market.length ? Math.max(...market) : null };
      if (result.unknownVersions.length > 0) result.problems.push(`migrasi yang tidak dikenal build ini: ${result.unknownVersions.join(", ")} (salinan dari build yang lebih baru)`);
    }
    if (tables.has("indexer_cursor")) {
      result.cursors = (db.prepare("SELECT name, last_block_height FROM indexer_cursor").all() as Array<{ name: string; last_block_height: number }>).map((r) => ({ name: r.name, lastBlockHeight: Number(r.last_block_height) }));
    }
  } catch (error) {
    result.problems.push(`tidak bisa dibaca: ${(error as Error).message}`);
  } finally {
    db.close();
  }
  result.ok = result.problems.length === 0;
  return result;
}

/** A consistent copy of a database that may be in use. The copy is written to a temporary name and renamed, so a copy that was cut short is never mistaken for a good one. */
export async function backupDatabase(source: Database.Database | string, dest: string): Promise<DatabaseCheck> {
  if (existsSync(dest)) throw new Error(`${dest} sudah ada: backup tidak menimpa`);
  const own = typeof source === "string";
  const db = own ? new Database(source, { readonly: true, fileMustExist: true }) : source;
  const tmp = `${dest}.partial`;
  try {
    rmSync(tmp, { force: true });
    await db.backup(tmp);
  } finally {
    if (own) db.close();
  }
  renameSync(tmp, dest);
  return checkDatabase(dest);
}

/**
 * Puts a checked copy at `dest` (the file the process opens). `dest` must not exist, or `force` must be true; its `-wal` and `-shm` are removed, because a leftover log of an older database
 * would be replayed over the restored one. The process must be stopped. The copy is made to a temporary name and renamed.
 */
export function restoreDatabase(backup: string, dest: string, options: { force?: boolean } = {}): DatabaseCheck {
  const check = checkDatabase(backup);
  if (!check.ok) throw new Error(`salinan tidak sehat: ${check.problems.join("; ")}`);
  if (existsSync(dest) && options.force !== true) throw new Error(`${dest} sudah ada: pakai force setelah proses dihentikan dan file lama disimpan`);
  const tmp = `${dest}.restoring`;
  rmSync(tmp, { force: true });
  copyFileSync(backup, tmp);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dest}${suffix}`, { force: true });
  renameSync(tmp, dest);
  const restored = checkDatabase(dest);
  if (!restored.ok) throw new Error(`hasil restore tidak sehat: ${restored.problems.join("; ")}`);
  return restored;
}
