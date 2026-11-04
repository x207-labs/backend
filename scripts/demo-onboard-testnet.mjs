// BE-080: puts the three demo accounts on the testnet circle: creates them through the faucet (if they do not exist), joins the circle with the voucher public key of the demo seed,
// mints mock USDT and stakes. Testnet only. Idempotent: an account that is a member is skipped. The secret keys of the accounts stay in <keys-dir>/testnet/<account>.json (mode 0600,
// outside the repository); the seed and the keys are never printed.
//   X207_DEMO_SEED=... X207_DEMO_SELLER=... X207_DEMO_BUYER=... X207_DEMO_HELPER=... node scripts/demo-onboard-testnet.mjs --keys-dir <dir> [--contract x207-v013.testnet]
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { demoKeys } from "../dist/demo/seed.js";
import { loadOrCreateKey } from "../../scripts/lib/accounts.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const { Account, JsonRpcProvider, KeyPairSigner } = createRequire(resolve(here, "../package.json"))("near-api-js");
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const need = (name) => {
  if (!process.env[name]) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return process.env[name];
};
const keysDir = resolve(opt("--keys-dir", ".keys"));
const CONTRACT = opt("--contract", "x207-v013.testnet");
const USDT = opt("--usdt", "usdt.x207-deployer.testnet");
const RPC = process.env.NEAR_RPC_PRIMARY_URL || "https://rpc.testnet.fastnear.com";
const STAKE = 100_000_000n; // 100 credit
const keys = demoKeys(need("X207_DEMO_SEED"));
const accounts = { seller: need("X207_DEMO_SELLER"), buyer: need("X207_DEMO_BUYER"), helper: need("X207_DEMO_HELPER") };
for (const a of Object.values(accounts)) if (!a.endsWith(".testnet")) { console.error("the demo accounts end with .testnet"); process.exit(2); }

const provider = new JsonRpcProvider({ url: RPC });
const view = async (contractId, method, argsObj = {}) => {
  const r = await provider.callFunction({ contractId, method, args: argsObj });
  return r;
};

// 1. the accounts (faucet, through the script of the umbrella repo; the keys are written to the keys dir)
const make = spawnSync(process.execPath, [resolve(here, "../../scripts/create-faucet-accounts.mjs"), "--keys-dir", keysDir, ...Object.values(accounts)], { encoding: "utf8" });
process.stdout.write(make.stdout.replace(/secret[^\n]*/gi, ""));
if (make.status !== 0) {
  console.error(make.stderr.slice(0, 400));
  process.exit(1);
}

const circle = await view(CONTRACT, "get_circle");
for (const role of ["seller", "buyer", "helper"]) {
  const id = accounts[role];
  const existing = await view(CONTRACT, "member", { account_id: id }).catch(() => null);
  if (existing) {
    console.log(`member  ${role} ${id} (stake ${existing.stake}, status ${existing.status})`);
    continue;
  }
  const signer = KeyPairSigner.fromSecretKey(loadOrCreateKey(keysDir, "testnet", id).toString());
  const account = new Account(id, provider, signer);
  // the terms the other members accepted (the circle itself carries none): the first member's
  const termsHash = (await view(CONTRACT, "list_members", { from_index: 0, limit: 1 }))[0]?.terms_hash ?? "a".repeat(64);
  await account.callFunction({ contractId: CONTRACT, methodName: "join", args: { circle_id: circle.circle_id, pubkey_voucher: keys[role].publicKey, terms_hash: termsHash }, deposit: 350_000_000_000_000_000_000_000n, gas: 100_000_000_000_000n });
  await account.callFunction({ contractId: USDT, methodName: "mint", args: { account_id: id, amount: (STAKE * 2n).toString() }, gas: 30_000_000_000_000n });
  await account.callFunction({ contractId: USDT, methodName: "ft_transfer_call", args: { receiver_id: CONTRACT, amount: STAKE.toString(), memo: null, msg: JSON.stringify({ action: "stake" }) }, deposit: 1n, gas: 150_000_000_000_000n });
  console.log(`joined  ${role} ${id} with ${keys[role].publicKey}`);
}
