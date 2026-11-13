// BE-077 on near-sandbox (contracts 0.0.13, CT-099): ONE epoch of 300 edges (60 members, each owes the next five one credit) is closed, proposed and committed. `commit_epoch` logs a
// summary `clearing_applied` (edge_count, edges_hash) and `epoch_committed` with all positions (position_count, positions_hash) and no chunk; the indexer reads the edges from the view
// `list_obligations` before the block, checks them against `edges_hash` (the hash of the SDK) and keeps them. The read model must equal the views of the contract: `cleared` of every
// pair, the positions, and the rebuild from `events_raw` and the kept edges (no RPC) gives the same result. The logs of the commit must stay under the 16 KiB of a receipt.
//
// Runs only on request: `X207_SANDBOX=1 npx vitest run test/sandbox/clearing-300`, with the binary of near-sandbox and the wasm of the contracts built with CT-099 (see docs/sandbox-e2e.md).
// ONE near-sandbox at a time on the machine (`pgrep -fl near-sandbox`).
import { afterAll, describe, expect, it } from "vitest";
import { edgesHash, generateVoucherKeypair, signVoucher } from "@x207/core";
import type { CircleFixture } from "../../../sdk/test-support/circle.js";
import { inUmbrella, umbrellaSkipReason } from "../helpers/umbrella.js";
import { FailoverRpcClient, Indexer, RpcBlockSource, openDatabase, rpcChainReader, viewClearedEdges } from "../../src/index.js";
import { rebuildReadModel } from "../../src/indexer/rebuild.js";

const CREDIT = 1_000_000n;
const STAKE = 500n * CREDIT;
const MEMBERS = 60;
const OFFSETS = 5; // 60 x 5 = 300 edges
const LOG_BUDGET = (16 * 1024) / 10 * 9;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// the near-sandbox fixtures are those of the SDK in the umbrella; a backend cloned on its own skips this file with the reason
const SUPPORT = "sdk/test-support/circle.js";
const umbrella = inUmbrella(SUPPORT);
const { sandboxAvailable } = umbrella ? await import("../../../sdk/test-support/sandbox.js") : { sandboxAvailable: false };
const { deployCircle, SHORT_PARAMS, TERMS_HASH } = umbrella ? await import("../../../sdk/test-support/circle.js") : ({} as typeof import("../../../sdk/test-support/circle.js"));
if (!umbrella) it.skip(`BE-077 ${umbrellaSkipReason(SUPPORT)}`, () => {});

describe.skipIf(!sandboxAvailable)("BE-077 an epoch of 300 edges on near-sandbox", () => {
  let fx: CircleFixture | undefined;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-BE-077-S01 commit_epoch of 300 edges: logs under 16 KiB, edges read from list_obligations, read model equal to the views, rebuild with no RPC gives the same", async () => {
    // an epoch of an hour: joining 60 members and 300 registrations take more than the 300 seconds of SHORT_PARAMS (ERR_PAST_CUTOFF)
    fx = await deployCircle({ ...SHORT_PARAMS, epoch_length: 3600 });
    const { sandbox, circle, usdt } = fx;
    const contract = circle.accountId;
    const rpcUrl = sandbox.rpcUrl;
    const ok = (r: { failures: string[] }, what: string) => expect(r.failures, what).toEqual([]);
    const blockHeight = async (): Promise<number> =>
      ((await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "block", params: { finality: "final" } }) })).json()) as { result: { header: { height: number } } }).result.header.height;

    // the indexer follows the chain while the flow runs (a sandbox forgets old outcomes after a few epochs of height)
    const startBlock = Math.max(1, (await blockHeight()) - 20); // a fresh sandbox is only a few blocks high: a negative block id is a parse error of the RPC
    const db = openDatabase(":memory:");
    const indexer = new Indexer({
      db, source: new RpcBlockSource(rpcChainReader(new FailoverRpcClient({ endpoints: [rpcUrl], timeoutMs: 30_000 })), contract, startBlock), circleId: fx.circleId, contractId: contract, startBlock,
      fetchParams: () => sandbox.view(contract, "get_params", {}), fetchClearedEdges: (epoch) => viewClearedEdges(rpcUrl, contract, epoch), prefetch: { attempts: 5, delayMs: 1_000 },
    });
    await indexer.bootstrap();
    const stop = new AbortController();
    const errors: string[] = [];
    const running = indexer.run({ signal: stop.signal, pollMs: 300, onError: (e) => errors.push(String((e as Error).message ?? e)) });
    const have = (event: string): number => (db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE event = ?").get(event) as { n: number }).n;
    const waitFor = async (event: string, n: number): Promise<void> => {
      for (let i = 0; i < 300; i++) {
        if (have(event) >= n) return;
        await sleep(500);
      }
      throw new Error(`the indexer did not store ${n} ${event}; errors: ${errors.slice(-3).join(" | ")}`);
    };

    try {
      // 60 members: accounts and USDT one at a time (the root account signs), join and stake in parallel
      const keys: Record<string, ReturnType<typeof generateVoucherKeypair>> = {};
      const accounts = [];
      for (let i = 0; i < MEMBERS; i++) {
        const account = await fx.member(`m${String(i).padStart(2, "0")}`);
        keys[account.accountId] = generateVoucherKeypair();
        accounts.push(account);
      }
      for (let from = 0; from < MEMBERS; from += 10) {
        await Promise.all(accounts.slice(from, from + 10).map(async (account) => {
          ok(await account.call({ receiverId: contract, methodName: "join", args: { circle_id: fx!.circleId, pubkey_voucher: keys[account.accountId]!.publicKey, terms_hash: TERMS_HASH }, deposit: 350_000_000_000_000_000_000_000n, gas: 100_000_000_000_000n }), `join ${account.accountId}`);
          ok(await account.call({ receiverId: usdt.accountId, methodName: "ft_transfer_call", args: { receiver_id: contract, amount: STAKE.toString(), memo: null, msg: JSON.stringify({ action: "stake" }) }, deposit: 1n, gas: 150_000_000_000_000n }), `stake ${account.accountId}`);
        }));
      }
      const epoch = (await sandbox.view<{ epoch: number; cutoff_at: string }>(contract, "get_epoch", {}));

      // 300 vouchers: for each offset every member registers its own, 60 transactions at a time (60 different signers)
      const edges: Array<{ debtor: string; creditor: string; cleared: string }> = [];
      for (let k = 1; k <= OFFSETS; k++) {
        await Promise.all(accounts.map(async (payer, i) => {
          const payee = accounts[(i + k) % MEMBERS]!;
          const { signature, ...voucher } = signVoucher({ circle: contract, payer: payer.accountId, payee: payee.accountId, epoch: epoch.epoch, seq: 1, cumulativeAmount: CREDIT.toString(), unit: "credit", resource: "https://s.example/api" }, keys[payer.accountId]!.secretKey);
          ok(await payer.call({ receiverId: contract, methodName: "register_voucher", args: { voucher, signature }, deposit: 0n, gas: 100_000_000_000_000n }), `register ${payer.accountId} -> ${payee.accountId}`);
          edges.push({ debtor: payer.accountId, creditor: payee.accountId, cleared: CREDIT.toString() });
        }));
      }
      expect(edges).toHaveLength(MEMBERS * OFFSETS);

      // the epoch ends: a keeper closes it, a solver proposes the ring in full, the keeper commits after the proposal window
      const keeper = await sandbox.createAccount("keeper", "10");
      const solver = await sandbox.createAccount("solver", "10");
      await sandbox.advanceTo(Number(BigInt(epoch.cutoff_at) / 1_000_000n) + 1000);
      await sleep(3_000);
      ok(await sandbox.accountFrom(keeper.accountId, keeper.secretKey).call({ receiverId: contract, methodName: "close_epoch", args: { epoch: epoch.epoch }, deposit: 0n, gas: 300_000_000_000_000n }), "close_epoch");
      await waitFor("epoch_cutoff", 1);
      const closed = await sandbox.view<{ proposal_deadline: string }>(contract, "get_epoch", { epoch: epoch.epoch });
      ok(await solver.call({ receiverId: contract, methodName: "submit_clearing", args: { epoch: epoch.epoch, edges }, deposit: 0n, gas: 300_000_000_000_000n }), "submit_clearing");
      await sandbox.advanceTo(Number(BigInt(closed.proposal_deadline) / 1_000_000n) + 1000);
      await sleep(3_000);
      const committed = await sandbox.accountFrom(keeper.accountId, keeper.secretKey).call({ receiverId: contract, methodName: "commit_epoch", args: { epoch: epoch.epoch }, deposit: 0n, gas: 300_000_000_000_000n });
      ok(committed, "commit_epoch");
      const logBytes = committed.logs.reduce((n, l) => n + l.length, 0);
      expect(logBytes, "the logs of commit_epoch").toBeLessThanOrEqual(LOG_BUDGET);
      await waitFor("clearing_applied", 1);
      await waitFor("epoch_committed", 1);
      for (let i = 0; i < 100 && (db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE handled = 0").get() as { n: number }).n > 0; i++) await sleep(300);

      // every event handled; the summary has no edges and no chunk
      expect(db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE handled = 0").get()).toEqual({ n: 0 });
      const applied = JSON.parse((db.prepare("SELECT data_json FROM events_raw WHERE event = 'clearing_applied'").get() as { data_json: string }).data_json) as Array<Record<string, unknown>> | Record<string, unknown>;
      const summary = (Array.isArray(applied) ? applied[0] : applied) as Record<string, unknown>;
      expect(summary).toMatchObject({ epoch: epoch.epoch, edge_count: 300 });
      expect(summary.edges).toBeUndefined();
      expect(summary.edges_hash).toBe(edgesHash(edges));

      // the read model equals the views: `cleared` of every pair
      const chainEdges = await viewClearedEdges(rpcUrl, contract, epoch.epoch);
      expect(chainEdges).toHaveLength(300);
      const rows = db.prepare("SELECT debtor, creditor, cleared FROM obligations WHERE circle_id = ? AND epoch = ?").safeIntegers(true).all(fx.circleId, epoch.epoch) as Array<{ debtor: string; creditor: string; cleared: bigint }>;
      expect(rows).toHaveLength(300);
      const byPair = new Map(rows.map((r) => [`${r.debtor}>${r.creditor}`, r.cleared.toString()]));
      for (const e of chainEdges) expect([e.debtor, e.creditor, byPair.get(`${e.debtor}>${e.creditor}`)]).toEqual([e.debtor, e.creditor, e.cleared]);
      expect(db.prepare("SELECT edge_count, cleared_total FROM clearing_log WHERE epoch = ?").safeIntegers(true).get(epoch.epoch)).toEqual({ edge_count: 300n, cleared_total: 300n * CREDIT });
      expect((db.prepare("SELECT COUNT(*) AS n FROM clearing_edges WHERE epoch = ?").get(epoch.epoch) as { n: number }).n).toBe(1);

      // the positions equal the contract (the ring is balanced: nobody owes, nobody is owed) and the totals are the sums
      const chainEpoch = await sandbox.view<Record<string, unknown>>(contract, "get_epoch", { epoch: epoch.epoch });
      expect(String(chainEpoch.phase)).toMatch(/payment|commit/i);
      for (const account of accounts) {
        const position = await sandbox.view<{ net: string; amount: string; status: string } | null>(contract, "net_position", { epoch: epoch.epoch, account_id: account.accountId });
        const row = db.prepare("SELECT net, amount, status FROM settlements WHERE circle_id = ? AND epoch = ? AND account_id = ?").safeIntegers(true).get(fx.circleId, epoch.epoch, account.accountId) as { net: bigint; amount: bigint; status: string | null } | undefined;
        expect(row, account.accountId).toBeDefined();
        expect([String(row!.net), String(row!.amount)], account.accountId).toEqual([position?.net ?? "0", position?.amount ?? "0"]);
      }
      expect(db.prepare("SELECT total_due, total_claimable FROM epochs WHERE epoch = ?").safeIntegers(true).get(epoch.epoch)).toEqual({ total_due: 0n, total_claimable: 0n });
      expect(db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE epoch = ?").get(epoch.epoch)).toEqual({ n: MEMBERS });

      // rebuild from events_raw and the kept edges, with no RPC: the same obligations and settlements
      const snapshot = (): unknown[] => [
        db.prepare("SELECT debtor, creditor, cleared FROM obligations ORDER BY debtor, creditor").all(),
        db.prepare("SELECT account_id, net, amount, status FROM settlements ORDER BY account_id").all(),
        db.prepare("SELECT epoch, phase, total_due, total_claimable, cleared_total FROM epochs ORDER BY epoch").all(),
      ];
      stop.abort();
      await running;
      const before = snapshot();
      rebuildReadModel(db, fx.circleId);
      expect(snapshot()).toEqual(before);
    } finally {
      stop.abort();
      await running.catch(() => undefined);
      db.close();
    }
  }, 3_600_000);
});
