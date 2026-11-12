// BE-120: post one signed listing to a backend that runs read-only (X207_READ_ONLY on), without opening POST to the public and without raw SQL.
// The script starts a second, private copy of the same API (same dist, same database, same marketplace and appraiser routes as src/main.ts) with
// read-only off only in this process, on 127.0.0.1 and a free port. It POSTs listings/check (dry run) and then listings through the normal handler,
// so the format, the circle, the member, the signature and the duplicate are checked exactly as for POST /x207/circles/{circle}/listings. Then it stops.
// No indexer, no job monitor, no settlement, no faucet: the running service keeps those.
//
// Run from the folder of a built backend, with the variables of the service on stdin (KEY=VALUE lines) and the signed { listing, signature } JSON:
//   sudo cat /etc/x207/backend.env | node scripts/post-listing-once.mjs <signed.json> [--check-only]
// Back up the database first (node scripts/db-backup.mjs backup <db> <backup>, or sqlite3 <db> ".backup <file>").
import { readFileSync } from "node:fs";
import { createApiServer, apiOptionsFromEnv } from "../dist/api/server.js";
import { openDatabase } from "../dist/db/index.js";
import { appConfigFromEnv } from "../dist/main.js";
import { marketplaceRoutes } from "../dist/marketplace/index.js";
import { daoRegistryFromFile } from "../dist/marketplace/dao-registry.js";
import { DnsTxtProof, TradeApiProof } from "../dist/marketplace/transfer-proofs.js";
import { FastNearAccountHistory } from "../dist/marketplace/account-history.js";
import { jsonRpcClaimRpc } from "../dist/marketplace/order-claims.js";
import { rpcViewFunction } from "../dist/settlement/intents.js";
import { abuseFromEnv } from "../dist/api/abuse.js";
import { appraiserFromEnv, appraiserRoutes } from "../dist/appraiser/appraiser.js";
import { createLogger } from "../dist/log.js";

const [signedFile, flag] = process.argv.slice(2);
if (!signedFile) {
  console.error("usage: <env on stdin> node scripts/post-listing-once.mjs <signed.json> [--check-only]");
  process.exit(2);
}
const body = readFileSync(signedFile, "utf8");
const { listing } = JSON.parse(body);

// KEY=VALUE lines, # comments, optional quotes; the values are never printed
const fileEnv = {};
for (const line of readFileSync(0, "utf8").split("\n")) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!m || line.trimStart().startsWith("#")) continue;
  fileEnv[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
}
if (!fileEnv.X207_DB_PATH || !fileEnv.X207_CONTRACT_ID) throw new Error("stdin must hold the variables of the service (X207_DB_PATH, X207_CONTRACT_ID, ...)");
const env = { ...process.env, ...fileEnv, X207_READ_ONLY: "0" };

const config = appConfigFromEnv(env);
const logger = createLogger({ write: (line) => console.error(line) });
const primary = config.rpcEndpoints[0];
const db = openDatabase(config.dbPath);
const server = createApiServer({
  db,
  ...apiOptionsFromEnv(env),
  logger,
  daoView: rpcViewFunction(primary),
  extraRoutes: [
    ...marketplaceRoutes(db, {
      chainView: rpcViewFunction(primary),
      claimRpc: jsonRpcClaimRpc(primary),
      openLimits: abuseFromEnv(env).open,
      ...(env.X207_CODE_SEEN_KEY ? { codeSeenKey: env.X207_CODE_SEEN_KEY } : {}),
      onIssuerError: (issuer, reason) => logger.warn("issuer error", { issuer, reason }),
      dnsTxt: new DnsTxtProof({ ...(env.X207_DOH_URL ? { dohUrl: env.X207_DOH_URL } : {}), ...(env.X207_RDAP_BASE_URL ? { rdapBaseUrl: env.X207_RDAP_BASE_URL } : {}) }),
      ...(env.X207_STEAM_API_KEY ? { tradeApi: new TradeApiProof({ apiKey: env.X207_STEAM_API_KEY }) } : {}),
      ...(env.X207_TX_INDEX_URL && env.X207_MPC_CONTRACT_ID ? { accountHistory: new FastNearAccountHistory({ txIndexUrl: env.X207_TX_INDEX_URL, mpcContractId: env.X207_MPC_CONTRACT_ID }) } : {}),
      daoRegistry: env.X207_DAO_REGISTRY_PATH ? daoRegistryFromFile(env.X207_DAO_REGISTRY_PATH) : [],
    }),
    ...appraiserRoutes(db, appraiserFromEnv(env)),
  ],
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const base = `http://127.0.0.1:${server.address().port}/x207/circles/${config.circleId}/listings`;
const post = async (url) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  return { status: response.status, body: await response.json().catch(() => null) };
};
try {
  const check = await post(`${base}/check`);
  console.log(JSON.stringify({ step: "check", circle: listing?.circle, account: listing?.account, ...check }));
  if (check.status >= 300) process.exitCode = 1;
  else if (flag !== "--check-only") {
    const created = await post(base);
    console.log(JSON.stringify({ step: "post", ...created }));
    if (created.status >= 300) process.exitCode = 1;
  }
} finally {
  await new Promise((done) => server.close(() => done()));
  db.close();
}
