// BE-080: fills a backend with one example of every pipeline that runs (class A, P2 to P8), through its API. Needs `npm run build` first.
//   X207_DEMO_SEED=<a secret string kept outside the repo> X207_DEMO_SELLER=<account> X207_DEMO_BUYER=<account> X207_DEMO_HELPER=<account> npm run demo:seed
//   node scripts/demo-seed.mjs --print-members     the accounts and the voucher public keys that they must join the circle with
// Variables: X207_CONTRACT_ID (the circle contract account), X207_API_URL (default http://127.0.0.1:8080), X207_CIRCLE_ID (default agents-main), X207_DEMO_EXPIRES_AT (unix seconds, the end of every listing; default 2026-12-31T00:00:00Z).
// Run it twice: the second run creates nothing. The seed is a secret and is never printed or logged; the public keys are.
import { demoKeys, seedDemo } from "../dist/demo/seed.js";

const env = process.env;
const flag = (name) => process.argv.includes(name);
const need = (name) => {
  const value = env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
};
const keys = demoKeys(need("X207_DEMO_SEED"));
const accounts = { seller: need("X207_DEMO_SELLER"), buyer: need("X207_DEMO_BUYER"), helper: need("X207_DEMO_HELPER") };

if (flag("--print-members")) {
  for (const role of ["seller", "buyer", "helper"]) console.log(`${role}\t${accounts[role]}\t${keys[role].publicKey}`);
  process.exit(0);
}

const base = (env.X207_API_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const circleId = env.X207_CIRCLE_ID ?? "agents-main";
const call = async (method, path, body) => {
  const response = await fetch(`${base}/x207/circles/${circleId}${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};
const contract = need("X207_CONTRACT_ID");
const results = await seedDemo(
  { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body) },
  {
    circleContract: contract, accounts, keys, nowS: Math.floor(Date.now() / 1000), expiresAt: Number(env.X207_DEMO_EXPIRES_AT ?? Date.parse("2026-12-31T00:00:00Z") / 1000),
    ...(flag("--domain") && env.X207_DEMO_DOMAIN ? { domain: env.X207_DEMO_DOMAIN } : {}),
  },
);
for (const r of results) console.log(`${r.outcome.padEnd(8)} ${r.pipeline.padEnd(16)} ${r.item}${r.detail ? `  (${r.detail})` : ""}`);
const count = (o) => results.filter((r) => r.outcome === o).length;
console.log(`created ${count("created")}, already there ${count("exists")}, skipped ${count("skipped")}, failed ${count("failed")}`);
process.exit(count("failed") > 0 ? 1 : 0);
