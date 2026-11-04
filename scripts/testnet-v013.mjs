// BE-079: the read model against the circle of interface 0.0.13 on testnet (CT-100). Reads blocks (neardata) and views (RPC) only; no transaction, no key.
//   node scripts/testnet-v013.mjs [contract]            READMODEL_DB=<file> keeps the database between runs (a second run reads only the new blocks); REBUILD=1 replays the kept events with the
//   handlers of this build first (no network): the way to test a change of a handler on the events that were already read
// It follows the chain from the first transaction of the account with the real indexer (with the reader of `list_obligations` for the summary `clearing_applied`), then compares the read model
// with the views of the contract: members, epochs, obligations (`cleared`), the cleared edges against `get_proposal` (`proposal_hash`, `edge_count`), the positions against `list_positions`, and
// the epochs whose pairs were pruned (`edges_unavailable`). Prints a JSON report.
import { createApiServer, Indexer, NeardataBlockSource, openDatabase, rebuildReadModel, viewClearedEdges, viewMembers } from "../dist/index.js";
import { marketplaceRoutes } from "../dist/marketplace/index.js";
import { MockCodeIssuer } from "../dist/marketplace/code-issuers.js";
import { demoKeys, seedDemo } from "../dist/demo/seed.js";

const CONTRACT = process.argv[2] ?? "x207-v013.testnet";
const RPC = process.env.NEAR_RPC_PRIMARY_URL || "https://rpc.testnet.fastnear.com";
const NEARDATA = process.env.NEARDATA_URL || "https://testnet.neardata.xyz";
const TXS = process.env.FASTNEAR_TX_URL || "https://tx.test.fastnear.com/v0/account";
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
async function pages(method, args = {}, size = 100) {
  const all = [];
  for (let from = 0; ; from += size) {
    const page = await view(method, { ...args, from_index: from, limit: size });
    all.push(...page);
    if (page.length < size) return all;
  }
}

const circle = await view("get_circle");
const CIRCLE_ID = circle.circle_id;
const interfaceVersion = await view("interface_version");
const params = await view("get_params");

// the transactions of the account from the index of FastNEAR: the blocks that matter are the ones of the transactions and the few after them (receipts and callbacks)
const catalog = async () => {
  const txs = new Map();
  let token = null;
  let count = 0;
  do {
    const r = await (await fetch(TXS, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: CONTRACT, limit: 200, ...(token ? { resume_token: token } : {}) }) })).json();
    for (const t of r.account_txs) txs.set(t.transaction_hash, t.tx_block_height);
    count = r.txs_count;
    token = r.resume_token ?? null;
  } while (token);
  return { txs, count };
};
const before = await catalog();
const heights = [...before.txs.values()];
const startBlock = Math.min(...heights) - 2;
const endBlock = Math.max(...heights) + 30;
const wanted = new Set();
for (const h of heights) for (let d = 0; d <= 8; d++) wanted.add(h + d);

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
const inner = new NeardataBlockSource({ baseUrl: NEARDATA, contractId: CONTRACT, fetch: slowFetch, timeoutMs: 30_000 });
// a block with no transaction of the account and none just before it has no log of the circle: it is not fetched (a skipped height for the indexer)
const source = { endpoint: inner.endpoint, finalHeight: async () => endBlock, getBlock: async (h) => (wanted.has(h) ? inner.getBlock(h) : null) };

const db = openDatabase(process.env.READMODEL_DB || "/tmp/x207-testnet-v013.sqlite");
const indexer = new Indexer({
  db, source, circleId: CIRCLE_ID, contractId: CONTRACT, startBlock, fetchParams: async () => params, fetchClearedEdges: (epoch) => viewClearedEdges(RPC, CONTRACT, epoch), fetchMembers: () => viewMembers(RPC, CONTRACT),
  prefetch: { attempts: 5, delayMs: 2000 },
});
await indexer.bootstrap();
const started = Date.now();
for (;;) {
  const cur = Number(db.prepare("SELECT last_block_height AS h FROM indexer_cursor WHERE contract_id = ?").get(CONTRACT)?.h);
  if (cur >= endBlock) break;
  await indexer.drain(1);
  if (wanted.has(cur) && (cur - startBlock) % 50 === 0) console.error(`block ${cur} of ${endBlock}`);
}
if (process.env.REBUILD === "1") rebuildReadModel(db, CIRCLE_ID);
const cursor = Number(db.prepare("SELECT last_block_height AS h FROM indexer_cursor WHERE contract_id = ?").get(CONTRACT).h);

// the mock issuer of the demo codes (BE-080) is registered so that a seeded code listing is accepted; nothing else of the market is configured
const server = createApiServer({ db, extraRoutes: marketplaceRoutes(db, { codeIssuers: { "demo-issuer": new MockCodeIssuer().issue("DEMO-GIFT-0001") } }) });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/x207/circles/${CIRCLE_ID}`;
const api = async (path) => (await fetch(base + path)).json();

const diffs = [];
const note = (area, what, detail = {}) => diffs.push({ area, what, ...detail });
const report = { contract: CONTRACT, circleId: CIRCLE_ID, interface: interfaceVersion, startBlock, readUpTo: endBlock, indexedTo: cursor, followedSeconds: Math.round((Date.now() - started) / 1000), counts: {}, epochs: [], diffs };
if (interfaceVersion !== "0.0.13") note("interface", "the contract is not 0.0.13", { interface: interfaceVersion });

report.counts.staleMembers = db.prepare("SELECT COALESCE(SUM(stale), 0) AS stale, COALESCE(SUM(fee_mismatches), 0) AS mismatches FROM members").get();
// ---- events: every row handled, none unknown
report.counts.eventsByName = Object.fromEntries(db.prepare("SELECT event, COUNT(*) AS n FROM events_raw GROUP BY event ORDER BY event").all().map((r) => [r.event, r.n]));
const unhandled = db.prepare("SELECT event, handled, COUNT(*) AS n FROM events_raw WHERE handled <> 1 GROUP BY event, handled").all();
if (unhandled.length > 0) note("events", "rows that are not handled", { rows: unhandled });
const coverage = { transactionsInIndex: before.count, listed: before.txs.size, blocksRead: wanted.size };
report.counts.coverage = coverage;

// ---- members
const chainMembers = await pages("list_members", {}, 50);
const apiMembers = (await api("/members?limit=200")).items ?? [];
report.counts.members = { chain: chainMembers.length, readModel: apiMembers.length };
if (JSON.stringify(chainMembers.map((m) => m.account_id).sort()) !== JSON.stringify(apiMembers.map((m) => m.account).sort())) note("members", "set of accounts differs");
for (const m of chainMembers) {
  const a = apiMembers.find((x) => x.account === m.account_id);
  if (!a) continue;
  const v = await view("member", { account_id: m.account_id });
  for (const [k, c, r] of [["status", v.status, a.status], ["stake", String(v.stake), a.stake], ["limit", String(v.limit), a.limit], ["pubkey_voucher", v.pubkey_voucher, a.pubkeyVoucher]]) if (c !== r) note("members", `${m.account_id}.${k}`, { chain: c, readModel: r });
}

// ---- epochs, obligations, the cleared edges, the positions
const epochNumbers = db.prepare("SELECT epoch FROM epochs WHERE circle_id = ? ORDER BY epoch").all(CIRCLE_ID).map((r) => Number(r.epoch));
for (const epoch of epochNumbers) {
  const row = db.prepare("SELECT * FROM epochs WHERE circle_id = ? AND epoch = ?").get(CIRCLE_ID, epoch);
  const entry = { epoch, phase: row.phase, edgesUnavailable: Number(row.edges_unavailable) === 1 };
  const c = await view("get_epoch", { epoch }).catch(() => null);
  if (c) {
    // D9 keeps four phases; the contract (and the API, from the clock) also says `cutoff` and `commit`, which are `clearing` in the table
    const d9Phase = { cutoff: "clearing", commit: "clearing" }[String(c.phase).toLowerCase()] ?? String(c.phase).toLowerCase();
    if (d9Phase !== row.phase) note("epochs", `epoch ${epoch}.phase`, { chain: c.phase, readModel: row.phase });
    if (c.phase !== "open" && String(c.edge_count) !== String(row.edge_count)) note("epochs", `epoch ${epoch}.edge_count`, { chain: c.edge_count, readModel: String(row.edge_count) });
    if (c.phase !== "open" && String(c.total_obligation) !== String(row.total_obligation)) note("epochs", `epoch ${epoch}.total_obligation`, { chain: c.total_obligation, readModel: String(row.total_obligation) });
    if (String(c.total_cleared ?? "0") !== String(row.cleared_total)) note("epochs", `epoch ${epoch}.cleared_total`, { chain: String(c.total_cleared), readModel: String(row.cleared_total) });
  }
  // obligations: the pairs and `cleared`; a pruned epoch has none on the chain and the read model must say so (`edges_unavailable`, cleared NULL)
  const chainObl = await pages("list_obligations", { epoch }, 100).catch(() => []);
  const rows = db.prepare("SELECT debtor, creditor, cumulative_amount, seq, cleared FROM obligations WHERE circle_id = ? AND epoch = ?").all(CIRCLE_ID, epoch);
  entry.obligations = { chain: chainObl.length, readModel: rows.length };
  if (chainObl.length > 0) {
    if (chainObl.length !== rows.length) note("obligations", `epoch ${epoch} count`, { chain: chainObl.length, readModel: rows.length });
    for (const o of chainObl) {
      const r = rows.find((x) => x.debtor === o.debtor && x.creditor === o.creditor);
      if (!r) { note("obligations", `epoch ${epoch}: ${o.debtor} > ${o.creditor} is not in the read model`); continue; }
      if (String(o.cumulative) !== String(r.cumulative_amount)) note("obligations", `epoch ${epoch}: ${o.debtor} > ${o.creditor}.cumulative`, { chain: String(o.cumulative), readModel: String(r.cumulative_amount) });
      if (String(o.last_seq) !== String(r.seq)) note("obligations", `epoch ${epoch}: ${o.debtor} > ${o.creditor}.seq`, { chain: String(o.last_seq), readModel: String(r.seq) });
      const chainCleared = o.cleared === undefined || o.cleared === null ? null : String(o.cleared);
      const modelCleared = r.cleared === null || r.cleared === undefined ? null : String(r.cleared);
      if (row.phase !== "open" && row.phase !== "clearing" && chainCleared !== modelCleared) note("obligations", `epoch ${epoch}: ${o.debtor} > ${o.creditor}.cleared`, { chain: chainCleared, readModel: modelCleared });
    }
  } else if (rows.length > 0 && (row.phase === "payment_window" || row.phase === "finalized")) {
    entry.pruned = true;
    if (!entry.edgesUnavailable) note("prune", `epoch ${epoch}: the contract has no pairs (pruned) and the read model is not marked edges_unavailable`);
    if (rows.some((r) => r.cleared !== null)) note("prune", `epoch ${epoch}: edges_unavailable but some cleared is not NULL`);
  }
  // the cleared edges kept by the indexer against the proposal of the contract (`proposal_hash` is `edges_hash` of the log)
  const kept = db.prepare("SELECT edges_hash, unavailable, edges_json FROM clearing_edges WHERE circle_id = ? AND epoch = ?").get(CIRCLE_ID, epoch);
  const proposal = await view("get_proposal", { epoch, from_index: 0, limit: 1 }).catch(() => null);
  if (kept) {
    entry.clearingEdges = { edgesHash: kept.edges_hash, unavailable: Number(kept.unavailable) === 1, edges: JSON.parse(kept.edges_json).length };
    const applied = db.prepare("SELECT data_json FROM events_raw WHERE event = 'clearing_applied' AND json_extract(data_json, '$[0].epoch') = ? OR (event = 'clearing_applied' AND json_extract(data_json, '$.epoch') = ?)").get(epoch, epoch);
    const data = applied ? JSON.parse(applied.data_json) : null;
    const ev = Array.isArray(data) ? data[0] : data;
    if (ev && ev.edges_hash !== kept.edges_hash) note("clearing_edges", `epoch ${epoch}: edges_hash of the event differs from the kept set`, { event: ev.edges_hash, kept: kept.edges_hash });
    if (proposal?.proposal_hash !== undefined && proposal.proposal_hash !== kept.edges_hash) note("clearing_edges", `epoch ${epoch}: proposal_hash of get_proposal differs from edges_hash`, { chain: proposal.proposal_hash, kept: kept.edges_hash });
    if (proposal?.edge_count !== undefined && ev && Number(proposal.edge_count) !== Number(ev.edge_count)) note("clearing_edges", `epoch ${epoch}: edge_count of get_proposal differs from the event`, { chain: proposal.edge_count, event: ev.edge_count });
    entry.proposal = proposal ? { committed: proposal.committed, edgeCount: proposal.edge_count, proposalHash: proposal.proposal_hash ?? null } : null;
  }
  // positions: `list_positions` against the table settlements
  const positions = await pages("list_positions", { epoch }, 100).catch(() => []);
  const settled = db.prepare("SELECT account_id, role, net, amount, status FROM settlements WHERE circle_id = ? AND epoch = ?").all(CIRCLE_ID, epoch);
  if (positions.length > 0 || settled.length > 0) {
    entry.positions = { chain: positions.length, readModel: settled.length };
    for (const p of positions) {
      const s = settled.find((x) => x.account_id === p.account_id);
      if (!s) { note("positions", `epoch ${epoch}: ${p.account_id} is not in settlements`); continue; }
      for (const [k, cv, rv] of [["net", String(p.net), String(s.net)], ["amount", String(p.amount), String(s.amount)], ["role", p.role, s.role]]) if (cv !== rv) note("positions", `epoch ${epoch}: ${p.account_id}.${k}`, { chain: cv, readModel: rv });
    }
  }
  report.epochs.push(entry);
}
report.counts.epochs = epochNumbers.length;
const after = await catalog();
if (Math.max(...after.txs.values()) > endBlock - 30) note("coverage", "a transaction came after the block that was read to; run again (the database is kept with READMODEL_DB)", { lastBlock: Math.max(...after.txs.values()), readUpTo: endBlock });
console.log(JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
// BE-080: with X207_DEMO_SEED (and the three demo accounts) the demo data is posted to this read model through the API, and stays in the database file (the listings, the order and the invoice
// are rows of this backend, not of the chain). The seed is a secret: it is read from the environment and never printed.
if (process.env.X207_DEMO_SEED) {
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const accounts = { seller: process.env.X207_DEMO_SELLER, buyer: process.env.X207_DEMO_BUYER, helper: process.env.X207_DEMO_HELPER };
  const results = await seedDemo({ get: (p) => call("GET", p), post: (p, b) => call("POST", p, b) }, {
    circleContract: CONTRACT, accounts, keys: demoKeys(process.env.X207_DEMO_SEED), nowS: Math.floor(Date.now() / 1000), expiresAt: Number(process.env.X207_DEMO_EXPIRES_AT ?? Date.parse("2026-12-31T00:00:00Z") / 1000),
  });
  for (const r of results) console.error(`${r.outcome.padEnd(8)} ${r.pipeline.padEnd(16)} ${r.item}${r.detail ? `  (${r.detail})` : ""}`);
  console.error(`seed: created ${results.filter((r) => r.outcome === "created").length}, already there ${results.filter((r) => r.outcome === "exists").length}, skipped ${results.filter((r) => r.outcome === "skipped").length}, failed ${results.filter((r) => r.outcome === "failed").length}`);
  if (results.some((r) => r.outcome === "failed")) process.exitCode = 1;
}
server.close();
db.close();
