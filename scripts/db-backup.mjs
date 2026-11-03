// BE-073: backup, check and restore of the SQLite file of the backend. Run it from the folder of the backend after `npm run build`.
//   node scripts/db-backup.mjs backup  <db file> <backup file>      consistent copy while the process runs; refuses to overwrite
//   node scripts/db-backup.mjs check   <file>                        integrity, tables, migrations this build knows; exit 1 when there is a problem
//   node scripts/db-backup.mjs restore <backup file> <db file> [--force]   STOP the process first; --force replaces an existing file (keep the old one)
import { backupDatabase, checkDatabase, restoreDatabase } from "../dist/db/backup.js";

const [command, a, b, flag] = process.argv.slice(2);
const show = (check) => console.log(JSON.stringify(check, null, 2));
try {
  if (command === "backup" && a && b) show(await backupDatabase(a, b));
  else if (command === "check" && a) {
    const check = checkDatabase(a);
    show(check);
    if (!check.ok) process.exitCode = 1;
  } else if (command === "restore" && a && b) show(restoreDatabase(a, b, { force: flag === "--force" }));
  else {
    console.error("usage: db-backup.mjs backup <db> <backup> | check <file> | restore <backup> <db> [--force]");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
