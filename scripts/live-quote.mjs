// BE-090: one live quote of 1Click for the residual of a creditor, through the real route `POST /x207/settlement/withdraw/quote` of this backend.
//   node scripts/live-quote.mjs [--db <read model sqlite>] [--amount <smallest unit>] [--recipient <address>] [--refund-to <NEAR account>]
// It serves the withdraw routes on a local port over a read model (only the tables `circles` and `members` are read), with `X207_SETTLEMENT_MODE=dry`: the call to 1Click is always `dry: true`,
// so no deposit address is made and no funds move. Without `ONECLICK_JWT` 1Click adds 25 bps to the quote; a JWT is never needed for a dry quote unless 1Click says so (then this script prints the answer and stops).
// Prints the command a client would run, the answer, and the time in UTC. `NEAR_RPC_MAINNET_URL` (default https://rpc.mainnet.fastnear.com) only checks that `refundTo` exists.
import { createApiServer, openDatabase } from "../dist/index.js";
import { withdrawRoutes } from "../dist/settlement/withdraw/routes.js";
import { OneClickClient } from "../dist/settlement/one-click.js";
import { settlementConfigFromEnv } from "../dist/settlement/config.js";
import { nearAccountExists } from "../dist/settlement/deposit/quote.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const dbPath = arg("db");
if (!dbPath) {
  console.error("usage: node scripts/live-quote.mjs --db <read model sqlite> [--amount 5000000] [--recipient 0x...] [--refund-to near]");
  process.exit(2);
}
const db = openDatabase(dbPath);
const member = db.prepare("SELECT circle_id AS circle, account_id AS account FROM members WHERE status = 'active' ORDER BY account_id LIMIT 1").get();
if (!member) throw new Error("the read model has no active member");

const config = settlementConfigFromEnv({ ...process.env, X207_SETTLEMENT_MODE: "dry" });
const client = new OneClickClient({ config });
const rpc = process.env.NEAR_RPC_MAINNET_URL || "https://rpc.mainnet.fastnear.com";
const server = createApiServer({ db, extraRoutes: [], settlement: { client, accountExists: nearAccountExists(rpc) } });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/x207/settlement/withdraw/quote`;

const request = {
  circle: member.circle, account: member.account,
  destinationAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", // USDC on Base
  amount: arg("amount", "5000000"), // 5 credit (USDT, 6 decimals)
  recipient: arg("recipient", "0x2CfF890f0378a11913B6129B2E97417a2c302680"),
  refundTo: arg("refund-to", "near"),
  dry: true,
};
const startedAt = new Date().toISOString();
const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
const answer = await response.json();
console.log(JSON.stringify({
  time_utc: startedAt, mode: config.mode, one_click: config.baseUrl, jwt: config.jwt === undefined ? "none" : "set",
  command: `curl -s -X POST $BACKEND/x207/settlement/withdraw/quote -H 'content-type: application/json' -d '${JSON.stringify(request)}'`,
  status: response.status, answer,
}, null, 2));
server.close();
db.close();
process.exit(response.status === 201 ? 0 : 1);
