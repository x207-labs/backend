// BE-067: the read model against a real circle on testnet. Reads blocks (neardata) and views (RPC) only; no transaction, no key.
//   node scripts/testnet-readmodel.mjs [contract] [deploy-tx-hash]
// It follows the chain from the block of the deploy transaction with the real indexer, then compares the read model (database and API) with the views of the contract, and the events with
// the logs of the transactions that the batch file lists. Prints a JSON report; nothing is written but the in-memory database.
import { readFileSync } from "node:fs";
import { createApiServer, Indexer, NeardataBlockSource, openDatabase } from "../dist/index.js";
import { marketplaceRoutes } from "../dist/marketplace/index.js";

const CONTRACT = process.argv[2] ?? "x207-b1-v011.testnet";
const DEPLOY_TX = process.argv[3] ?? "A728oChvbdwZ9NVfvgDnx9NVxMrAsLL73hCDK6gar6Wv";
const RPC = process.env.NEAR_RPC_PRIMARY_URL || "https://rpc.testnet.fastnear.com";
const NEARDATA = process.env.NEARDATA_URL || "https://testnet.neardata.xyz";
const BATCH = process.argv[4] ?? new URL("../../docs/testnet-batch1.json", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x", method, params }), signal: AbortSignal.timeout(20_000) });
    if (r.status === 429 || r.status >= 500) { await sleep(1000 * (i + 1)); continue; }
    return r.json();
  }
  throw new Error(`rpc ${method}: rate limited`);
}
async function view(method, args = {}) {
  const out = await rpc("query", { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  if (out.error || out.result?.error) throw new Error(`${method}: ${JSON.stringify(out.error ?? out.result.error).slice(0, 200)}`);
  return JSON.parse(Buffer.from(out.result.result).toString("utf8"));
}

const circle = await view("get_circle");
const CIRCLE_ID = circle.circle_id;
const params = await view("get_params");
const deploy = await rpc("EXPERIMENTAL_tx_status", { tx_hash: DEPLOY_TX, sender_account_id: CONTRACT, wait_until: "FINAL" });
const deployBlock = (await rpc("block", { block_id: deploy.result.transaction_outcome.block_hash })).result.header.height;
const startBlock = deployBlock - 2;

// the transactions that touch the account, from the index of FastNEAR: the last one tells how far the indexer has to read (the free neardata gives 30 blocks a minute, so reading to the tip of a chain is slow)
const catalog = async () => {
  const txs = new Map();
  let token = null;
  let count = 0;
  do {
    const r = await (await fetch(process.env.FASTNEAR_TX_URL || "https://tx.test.fastnear.com/v0/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: CONTRACT, limit: 200, ...(token ? { resume_token: token } : {}) }) })).json();
    for (const t of r.account_txs) txs.set(t.transaction_hash, t.tx_block_height);
    count = r.txs_count;
    token = r.resume_token ?? null;
  } while (token);
  return { txs, count };
};
const before = await catalog();
const endBlock = Math.max(...before.txs.values()) + 30; // receipts and callbacks run some blocks after the transaction

// the free neardata answers 429 above 30 blocks a minute: one request every 2.1 s, and wait when it still says no
let lastCall = 0;
const slowFetch = async (url, init) => {
  for (let i = 0; i < 12; i++) {
    const wait = lastCall + 2100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const r = await fetch(url, init);
    if (r.status !== 429) return r;
    await sleep(15_000);
  }
  throw new Error("neardata: rate limited");
};
// the database is kept in a file, so a second run (a better comparison) does not read the chain again: delete the file to start over
const db = openDatabase(process.env.READMODEL_DB || "/tmp/x207-testnet-readmodel.sqlite");
const source = new NeardataBlockSource({ baseUrl: NEARDATA, contractId: CONTRACT, fetch: slowFetch, timeoutMs: 30_000 });
const indexer = new Indexer({ db, source, circleId: CIRCLE_ID, contractId: CONTRACT, startBlock, fetchParams: async () => params });
await indexer.bootstrap();
const started = Date.now();
const tip = endBlock;
for (;;) {
  const cur = Number(db.prepare("SELECT last_block_height AS h FROM indexer_cursor WHERE contract_id = ?").get(CONTRACT)?.h);
  if (cur >= endBlock) break;
  await indexer.drain(1);
  if ((cur - startBlock) % 100 === 0) console.error(`block ${cur} of ${endBlock}`);
}
const cursor = Number(db.prepare("SELECT last_block_height AS h FROM indexer_cursor WHERE contract_id = ?").get(CONTRACT).h);

const server = createApiServer({ db, extraRoutes: marketplaceRoutes(db) });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/x207/circles/${CIRCLE_ID}`;
const api = async (path) => (await fetch(base + path)).json();

const diffs = [];
const note = (area, what, detail) => diffs.push({ area, what, ...detail });
const report = { contract: CONTRACT, circleId: CIRCLE_ID, interface: await view("interface_version"), startBlock, tip, indexedTo: cursor, followedSeconds: Math.round((Date.now() - started) / 1000), counts: {}, notes: [] };

// ---- members
const chainMembers = [];
for (let from = 0; ; from += 50) {
  const page = await view("list_members", { from_index: from, limit: 50 });
  chainMembers.push(...page);
  if (page.length < 50) break;
}
const apiMembers = [];
for (let cursorTok = null; ;) {
  const page = await api(`/members?limit=200${cursorTok ? `&cursor=${cursorTok}` : ""}`);
  apiMembers.push(...page.items);
  if (!page.nextCursor) break;
  cursorTok = page.nextCursor;
}
report.counts.members = { chain: chainMembers.length, readModel: apiMembers.length };
const chainIds = chainMembers.map((m) => m.account_id).sort();
const apiIds = apiMembers.map((m) => m.account).sort();
if (JSON.stringify(chainIds) !== JSON.stringify(apiIds)) note("members", "set of accounts differs", { chain: chainIds, readModel: apiIds });
for (const m of chainMembers) {
  const v = await view("member", { account_id: m.account_id });
  const debt = await view("outstanding_debt", { account_id: m.account_id });
  const a = apiMembers.find((x) => x.account === m.account_id);
  const row = db.prepare("SELECT *, CAST(joined_at_ns AS TEXT) AS joined_text FROM members WHERE circle_id = ? AND account_id = ?").get(CIRCLE_ID, m.account_id);
  if (!a || !row) continue;
  const cmp = {
    status: [v.status, a.status], stake: [String(v.stake), a.stake], limit: [String(v.limit), a.limit], outstanding_debt: [String(debt), a.outstandingDebt],
    pubkey_voucher: [v.pubkey_voucher, a.pubkeyVoucher], terms_hash: [v.terms_hash, a.termsHash],
    "row.joined_at_ns": [String(v.joined_at), String(row.joined_text)], "row.admitted": [v.admitted ? "1" : "0", String(row.admitted)], "row.settled_history": [String(v.settled_history), String(row.settled_history)],
    "row.exit_requested_epoch": [String(v.exit_requested_epoch), String(row.exit_requested_epoch)],
  };
  for (const [k, [c, r]] of Object.entries(cmp)) if (c !== r) note("members", `${m.account_id}.${k}`, { chain: c, readModel: r });
}

// ---- grants and escrows
const grantRows = db.prepare("SELECT * FROM grants WHERE circle_id = ? ORDER BY grant_id").all(CIRCLE_ID);
let maxChain = 0;
const chainGrants = new Map();
for (let id = 1; id < 400; id++) {
  let g = null;
  try { g = await view("get_grant", { grant_id: id }); } catch { /* none */ }
  if (g === null || g === undefined) { if (id > grantRows.length + 5 && id > maxChain + 5) break; continue; }
  chainGrants.set(id, g);
  maxChain = id;
}
report.counts.grants = { chain: chainGrants.size, readModel: grantRows.length };
for (const row of grantRows) {
  const g = chainGrants.get(row.grant_id);
  if (!g) { note("grants", `grant ${row.grant_id} is in the read model and not in the contract`, { readModel: { status: row.status } }); continue; }
  const cmp = {
    grantor: [g.grantor, row.grantor], grantee: [g.grantee ?? null, row.grantee], class: [g.class, row.class], asset_type: [g.asset_type, row.asset_type], unit: [g.unit, row.unit], unit_price: [String(g.unit_price), String(row.unit_price)],
    status: [String(g.status).toLowerCase(), row.status], expires_at: [String(g.limits.expires_at), String(row.expires_at_ns)], delivery_pubkey: [String(g.delivery_pubkey), String(row.delivery_pubkey)],
  };
  for (const [k, [c, r]] of Object.entries(cmp)) if (c !== r) note("grants", `grant ${row.grant_id}.${k}`, { chain: c, readModel: r });
}
for (const id of chainGrants.keys()) if (!grantRows.some((r) => r.grant_id === id)) note("grants", `grant ${id} is in the contract and not in the read model`, {});
const apiGrant = await api("/grants?limit=200");
report.counts.grantsApi = apiGrant.items?.length ?? null;
if ((apiGrant.items?.length ?? 0) !== grantRows.length) note("grants", "the API lists a different number of grants than the table (default filter)", { api: apiGrant.items?.length ?? null, table: grantRows.length, statuses: [...new Set(grantRows.map((r) => r.status))] });

const escrowRows = db.prepare("SELECT * FROM escrows WHERE circle_id = ? ORDER BY grant_id").all(CIRCLE_ID);
report.counts.escrows = { readModel: escrowRows.length, byState: {} };
for (const e of escrowRows) {
  report.counts.escrows.byState[e.state] = (report.counts.escrows.byState[e.state] ?? 0) + 1;
  const method = e.kind === "nft" ? "get_escrow" : e.kind === "ft" ? "get_ft_escrow" : "get_mt_escrow";
  let c = null;
  try { c = await view(method, { grant_id: e.grant_id }); } catch (err) { c = { error: String(err.message).slice(0, 100) }; }
  // the contract keeps the record with its state (delivered stays delivered): state and what is held must be the same
  if (c === null || c.error) { note("escrows", `grant ${e.grant_id} (${e.kind}) is ${e.state} in the read model and the contract has none`, { chain: c }); continue; }
  const pairs = { state: [c.state, e.state], buyer: [c.buyer ?? null, null], token_id: [c.token_id ?? null, e.token_id ?? null], amount: [c.amount === undefined ? null : String(c.amount), e.amount ?? null], contract: [c.nft_contract ?? c.ft_contract ?? c.mt_contract ?? null, e.nft_contract ?? e.ft_contract ?? e.mt_contract ?? null] };
  delete pairs.buyer;
  for (const [k, [cv, rv]] of Object.entries(pairs)) if (cv !== rv) note("escrows", `grant ${e.grant_id}.${k}`, { chain: cv, readModel: rv });
}
const chainEscrowIds = [];
for (const id of chainGrants.keys()) {
  for (const m of ["get_escrow", "get_ft_escrow", "get_mt_escrow"]) {
    const c = await view(m, { grant_id: id }).catch(() => null);
    if (c) { chainEscrowIds.push(id); break; }
  }
}
if (JSON.stringify(chainEscrowIds) !== JSON.stringify(escrowRows.map((e) => e.grant_id))) note("escrows", "set of grants with an escrow differs", { chain: chainEscrowIds, readModel: escrowRows.map((e) => e.grant_id) });

// ---- epochs and obligations
const epochs = db.prepare("SELECT epoch, phase FROM epochs WHERE circle_id = ? ORDER BY epoch").all(CIRCLE_ID);
report.counts.epochs = epochs.length;
for (const e of epochs) {
  let c = null;
  try { c = await view("get_epoch", { epoch: Number(e.epoch) }); } catch { /* pruned */ }
  const erow = db.prepare("SELECT * FROM epochs WHERE circle_id = ? AND epoch = ?").get(CIRCLE_ID, e.epoch);
  if (c) {
    if (String(c.phase).toLowerCase() !== e.phase) note("epochs", `epoch ${e.epoch}.phase`, { chain: c.phase, readModel: e.phase });
    const apiEpoch = (await api("/epochs?limit=200")).items.find((x) => x.epoch === Number(e.epoch));
    for (const [k, cv, rv] of [["edgeCount", c.edge_count, apiEpoch?.edgeCount], ["totalObligation", c.total_obligation, apiEpoch?.totalObligation]]) if (String(cv) !== String(rv)) note("epochs", `epoch ${e.epoch}.${k} (API)`, { chain: String(cv), readModel: String(rv) });
    // epoch 1: its cutoff is known from the contract only (no event carries it); the cutoff of every later epoch comes in `epoch_cutoff` of the one before
    if (String(c.cutoff_at) !== String(erow.cutoff_at_ns)) note("epochs", `epoch ${e.epoch}.cutoff_at`, { chain: String(c.cutoff_at), readModel: String(erow.cutoff_at_ns), explained: e.epoch === 1 ? "epoch 1 opens in the call new, which emits no event" : "unexpected" });
  }
  const chainObl = await view("list_obligations", { epoch: Number(e.epoch), from_index: 0, limit: 200 }).catch(() => []);
  const rows = db.prepare("SELECT debtor, creditor, cumulative_amount, seq, cleared FROM obligations WHERE circle_id = ? AND epoch = ?").all(CIRCLE_ID, e.epoch);
  for (const o of chainObl) {
    const r = rows.find((x) => x.debtor === o.debtor && x.creditor === o.creditor);
    if (!r) { note("obligations", `${o.debtor} > ${o.creditor} is in the contract and not in the read model`, {}); continue; }
    if (String(o.cumulative) !== String(r.cumulative_amount)) note("obligations", `${o.debtor} > ${o.creditor}.cumulative`, { chain: String(o.cumulative), readModel: String(r.cumulative_amount) });
    if (String(o.last_seq) !== String(r.seq)) note("obligations", `${o.debtor} > ${o.creditor}.seq`, { chain: String(o.last_seq), readModel: String(r.seq) });
  }
  report.counts[`obligations@${e.epoch}`] = { chain: chainObl.length, readModel: rows.length };
  if (chainObl.length !== rows.length) note("obligations", `epoch ${e.epoch} count`, { chain: chainObl.length, readModel: rows.length });
}

// ---- events: the logs of the transactions that the batch file lists against events_raw
const steps = JSON.parse(readFileSync(BATCH, "utf8")).steps.filter((s) => typeof s.hash === "string" && s.hash.length > 30);
const seenTx = new Set();
let txChecked = 0, logsChain = 0, logsModel = 0, txMissing = 0;
for (const s of steps) {
  if (seenTx.has(s.hash)) continue;
  seenTx.add(s.hash);
  const out = await rpc("EXPERIMENTAL_tx_status", { tx_hash: s.hash, sender_account_id: s.account, wait_until: "FINAL" });
  if (!out.result) { txMissing += 1; note("events", `tx ${s.hash} not available from the RPC (${s.step})`, { error: JSON.stringify(out.error ?? {}).slice(0, 100) }); continue; }
  const chainLogs = [];
  for (const o of out.result.receipts_outcome ?? []) {
    if (o.outcome.executor_id !== CONTRACT) continue;
    for (const l of o.outcome.logs) if (l.startsWith("EVENT_JSON:")) { const j = JSON.parse(l.slice(11)); chainLogs.push(j.event); }
  }
  const rows = db.prepare("SELECT event FROM events_raw WHERE tx_hash = ? AND contract_id = ? ORDER BY block_height, receipt_id, log_index").all(s.hash, CONTRACT).map((r) => r.event);
  txChecked += 1; logsChain += chainLogs.length; logsModel += rows.length;
  if (JSON.stringify([...chainLogs].sort()) !== JSON.stringify([...rows].sort())) note("events", `tx ${s.hash} (${s.step})`, { chain: chainLogs, readModel: rows });
  await sleep(150);
}
report.counts.events = { transactionsChecked: txChecked, logsInChain: logsChain, logsInReadModel: logsModel, unavailable: txMissing, rowsInReadModel: db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE contract_id = ?").get(CONTRACT).n, unhandled: db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE handled = 0").get().n };
report.counts.eventsByName = Object.fromEntries(db.prepare("SELECT event, COUNT(*) AS n FROM events_raw GROUP BY event ORDER BY event").all().map((r) => [r.event, r.n]));
const after = await catalog();
report.counts.transactionsInIndex = { atStart: before.count, atEnd: after.count, listed: after.txs.size, lastBlock: Math.max(...after.txs.values()), readUpTo: endBlock };
if (Math.max(...after.txs.values()) >= endBlock - 5) note("coverage", "a transaction came after the block that was read to", { lastBlock: Math.max(...after.txs.values()), readUpTo: endBlock });
report.diffs = diffs;
console.log(JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
server.close();
db.close();
