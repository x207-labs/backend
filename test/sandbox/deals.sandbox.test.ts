// BE-065 on near-sandbox (contracts 0.0.12, CT-094): a swap with an arbiter locks a bond on each side, one party complains, the arbiter rules `accused_guilty`; the indexer must take
// `bond_locked`, `deal_disputed`, `bond_slashed`, `bond_released` and `deal_ruled`, and the stake and the limit of both parties in the read model must equal the view `member`
// of the contract. `limits_updated` is not expected: the contract demands a stake above the limit by at least the bond (ERR_BOND_INSUFFICIENT_STAKE), so a slash never pushes the stake under the limit; the event
// after a ruling is covered by test/indexer/rules.test.ts. The freeze path (`propose_freeze`, then `apply_freeze` after a day) is not run here: a fast forward of 24 hours is too long for a unit run; it is covered by test/indexer/rules.test.ts.
//
// Runs only on request: `X207_SANDBOX=1 npx vitest run test/sandbox`, with the binary of near-sandbox and the wasm of the contracts (0.0.12) built (see docs/sandbox-e2e.md). ONE near-sandbox at a time.
import { afterAll, describe, expect, it } from "vitest";
import { bundleInput, generateVoucherKeypair, signBundle, type BundleTerms } from "@x207/core";
import { sandboxAvailable } from "../../../sdk/test-support/sandbox.js";
import { deployCircle, SHORT_PARAMS, TERMS_HASH, type CircleFixture } from "../../../sdk/test-support/circle.js";
import { FailoverRpcClient, Indexer, RpcBlockSource, openDatabase, rpcChainReader } from "../../src/index.js";

const CREDIT = 1_000_000n;
const STAKE = 500n * CREDIT;
const VALUE = 120n * CREDIT;
const BOND = 24n * CREDIT; // 20% of the value 120, above the threshold of 100
const AGREEMENT = "cd".repeat(32);
const EVIDENCE = "ef".repeat(32);

describe.skipIf(!sandboxAvailable)("BE-065 bonds and rulings on near-sandbox", () => {
  let fx: CircleFixture | undefined;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-BE-065-S01 after rule_deal the stake and the limit in the read model are those of the contract, and the events of the deal are all handled", async () => {
    fx = await deployCircle(SHORT_PARAMS);
    const { sandbox, circle, usdt } = fx;
    const contract = circle.accountId;
    const rpcUrl = sandbox.rpcUrl;
    const height = async (): Promise<number> => ((await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "block", params: { finality: "final" } }) })).json()) as { result: { header: { height: number } } }).result.header.height;
    const startBlock = (await height()) - 5;
    const db = openDatabase(":memory:");
    const indexer = new Indexer({ db, source: new RpcBlockSource(rpcChainReader(new FailoverRpcClient({ endpoints: [rpcUrl], timeoutMs: 30_000 })), contract, startBlock), circleId: fx.circleId, contractId: contract, startBlock, fetchParams: () => sandbox.view(contract, "get_params", {}) });
    await indexer.bootstrap();
    const have = (event: string): number => (db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE event = ?").get(event) as { n: number }).n;
    const follow = async (event: string, events: number) => {
      for (let i = 0; i < 150; i++) {
        await indexer.drain(200);
        if (have(event) >= events) return;
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error(`the indexer did not store ${events} ${event} event(s)`);
    };
    const ok = (r: { failures: string[] }, what: string) => expect(r.failures, what).toEqual([]);

    // three members join and stake; the arbiter is an account that is not a member
    const keys: Record<string, ReturnType<typeof generateVoucherKeypair>> = {};
    const names = ["alice", "bob"] as const;
    for (const name of names) {
      const account = await fx.member(name);
      keys[account.accountId] = generateVoucherKeypair();
      ok(await account.call({ receiverId: contract, methodName: "join", args: { circle_id: fx.circleId, pubkey_voucher: keys[account.accountId]!.publicKey, terms_hash: TERMS_HASH }, deposit: 350_000_000_000_000_000_000_000n, gas: 100_000_000_000_000n }), `join ${name}`);
      ok(await account.call({ receiverId: usdt.accountId, methodName: "ft_transfer_call", args: { receiver_id: contract, amount: STAKE.toString(), memo: null, msg: JSON.stringify({ action: "stake" }) }, deposit: 1n, gas: 150_000_000_000_000n }), `stake ${name}`);
    }
    const arbiter = await sandbox.createAccount("arbiter", "10");
    const alice = (await fx.member("alice")).accountId;
    const bob = (await fx.member("bob")).accountId;
    await follow("stake_added", 2);

    const limitBefore = { alice: (await sandbox.view<{ limit: string }>(contract, "member", { account_id: alice })).limit, bob: (await sandbox.view<{ limit: string }>(contract, "member", { account_id: bob })).limit };
    // the swap of 120 and 100 credit with the arbiter, a window of one day
    const epoch = (await sandbox.view<{ epoch: number }>(contract, "get_epoch", {})).epoch;
    const terms: BundleTerms = {
      circle: contract, epoch,
      legs: [{ payer: alice, payee: bob, max_amount: VALUE.toString() }, { payer: bob, payee: alice, max_amount: (100n * CREDIT).toString() }],
      arbiter: arbiter.accountId, agreement_hash: AGREEMENT, confirm_by: ((BigInt(await sandbox.blockTimestampMs()) + 86_400_000n) * 1_000_000n).toString(),
    };
    const signatures = [alice, bob].map((a) => signBundle(terms, a, keys[a]!.secretKey)).map((s) => ({ account_id: s.account, signature: s.signature }));
    const committed = await (await fx.member("alice")).call({ receiverId: contract, methodName: "commit_bundle", args: { bundle: bundleInput(terms), signatures }, deposit: 0n, gas: 200_000_000_000_000n }, "EXECUTED_OPTIMISTIC");
    ok(committed, "commit_bundle");
    const bundleId = (await sandbox.view<{ bundle_id?: number }[] | unknown>(contract, "bond_locked", { account_id: alice })) && Number(JSON.parse(committed.logs.find((l) => l.includes("bundle_committed"))!.replace(/^EVENT_JSON:/, "")).data[0].bundle_id);
    await follow("bond_locked", 2);

    // alice complains about bob; the arbiter finds bob at fault
    ok(await (await fx.member("alice")).call({ receiverId: contract, methodName: "dispute_deal", args: { bundle_id: bundleId, evidence_hash: EVIDENCE }, deposit: 0n }, "EXECUTED_OPTIMISTIC"), "dispute_deal");
    ok(await arbiter.call({ receiverId: contract, methodName: "rule_deal", args: { bundle_id: bundleId, verdict: "accused_guilty" }, deposit: 0n }, "EXECUTED_OPTIMISTIC"), "rule_deal");
    await follow("deal_ruled", 1);
    await follow("bond_slashed", 1);
    await follow("bond_released", 1);
    await indexer.drain(200);

    try {
      // every event of the deal is handled, none unknown
      expect(db.prepare("SELECT COUNT(*) AS n FROM events_raw WHERE handled = 0").get()).toEqual({ n: 0 });
      for (const event of ["bond_locked", "deal_disputed", "bond_slashed", "bond_released", "deal_ruled"]) expect(have(event), event).toBeGreaterThanOrEqual(1);
      // the read model equals the contract for both parties
      for (const account of [alice, bob]) {
        const chain = await sandbox.view<{ stake: string; limit: string }>(contract, "member", { account_id: account });
        const row = db.prepare("SELECT stake, credit_limit FROM members WHERE circle_id = ? AND account_id = ?").get(fx.circleId, account) as { stake: bigint | number; credit_limit: bigint | number };
        expect({ account, stake: String(row.stake), limit: String(row.credit_limit) }).toEqual({ account, stake: chain.stake, limit: chain.limit });
      }
      // the ruling leaves the limits as they were (stake minus bond stays above the limit), in the contract and in the read model
      for (const [name, account] of [["alice", alice], ["bob", bob]] as const) {
        expect((await sandbox.view<{ limit: string }>(contract, "member", { account_id: account })).limit, name).toBe(limitBefore[name]);
        expect(String((db.prepare("SELECT credit_limit FROM members WHERE circle_id = ? AND account_id = ?").get(fx.circleId, account) as { credit_limit: bigint | number }).credit_limit), name).toBe(limitBefore[name]);
      }
      const after = await sandbox.view<{ stake: string }>(contract, "member", { account_id: bob });
      expect(after.stake).toBe((STAKE - BOND).toString());
    } finally {
      db.close();
    }
  }, 600_000);
});
