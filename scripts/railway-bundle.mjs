// BE-089: makes the folder that `railway up` uploads for the public read API (GET only) of the testnet circle.
//   node scripts/railway-bundle.mjs <out dir> <read model sqlite>      (run `npm run build` first)
// The folder holds the built backend (`dist`), a copy of `@x207/core` (`vendor/x207-core`, it is not on the npm registry), the Dockerfile, `start.sh`, `railway.json` and a SEED: the read model
// without the tables of the marketplace, so the first start has the circle replayed up to a block and the indexer follows the chain from there (a walk from the first block takes hours).
// Nothing secret goes in: the seed is public chain data and the variables are public URLs (see deploy/railway/README.md).
import Database from "better-sqlite3";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [out, source] = process.argv.slice(2);
if (!out || !source) {
  console.error("usage: node scripts/railway-bundle.mjs <out dir> <read model sqlite>");
  process.exit(2);
}
if (!existsSync(join(root, "dist/main.js"))) throw new Error("run `npm run build` first");
const core = resolve(root, "../sdk/packages/core");
if (!existsSync(join(core, "dist/index.js"))) throw new Error("build the SDK first: ../sdk/packages/core/dist is missing");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "seed"), { recursive: true });
cpSync(join(root, "dist"), join(out, "dist"), { recursive: true });
mkdirSync(join(out, "vendor/x207-core"), { recursive: true });
copyFileSync(join(core, "package.json"), join(out, "vendor/x207-core/package.json"));
cpSync(join(core, "dist"), join(out, "vendor/x207-core/dist"), { recursive: true });
for (const f of ["Dockerfile", "start.sh", "railway.json"]) copyFileSync(join(root, "deploy/railway", f), join(out, f));
writeFileSync(join(out, ".railwayignore"), "node_modules\n*.log\n.env*\n");
writeFileSync(join(out, ".dockerignore"), "node_modules\n*.log\n.env*\n");

const own = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "x207-backend-deploy", version: own.version, private: true, type: "module", description: "x207 backend read API and indexer, built from the backend repo (BE-089)",
  engines: own.engines, scripts: { start: "sh start.sh" },
  dependencies: { ...Object.fromEntries(Object.entries(own.dependencies).filter(([k]) => k !== "@x207/core")), "@x207/core": "file:vendor/x207-core" },
}, null, 2));

// the seed: a copy of the read model without the tables of the marketplace (listings, orders, purchases, ...): those are not on the chain and are not for a public copy
const seed = join(out, "seed/x207-seed.sqlite");
copyFileSync(source, seed);
const db = new Database(seed);
db.pragma("wal_checkpoint(TRUNCATE)");
const marketplace = [...readFileSync(join(root, "src/marketplace/migrations.ts"), "utf8").matchAll(/CREATE TABLE ([a-z_]+)/g)].map((m) => m[1]);
for (const table of [...new Set(marketplace)].concat("settlement_jobs")) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) db.exec(`DELETE FROM ${table}`);
}
db.exec("VACUUM");
const cursor = db.prepare("SELECT last_block_height AS h FROM indexer_cursor").get();
const members = db.prepare("SELECT count(*) AS n FROM members").get();
db.close();
console.log(JSON.stringify({ out, seed, lastBlockHeight: cursor?.h ?? null, members: members.n }));
