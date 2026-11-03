// BE-055 on near-sandbox: the keeper that is the seller of an order calls `close_epoch` on the real contract; the indexer (RpcBlockSource over the sandbox) stores the event with the signer of the
// transaction; `GET orders/{hash}/onchain-proofs` lists that transaction and not the one of another account; `payForProofs` of the SDK makes one voucher for it.
//
// Runs only on request: `X207_SANDBOX=1 npx vitest run test/sandbox`, with the binary of near-sandbox and the wasm of the contracts built (see docs/sandbox-e2e.md). ONE near-sandbox at a time on
// this machine: check `pgrep -fl near-sandbox` first (the suite of the contracts uses it). A run takes about a minute.
import { afterAll, describe, expect, it } from "vitest";
import { generateVoucherKeypair, orderHash, payForProofs, serializeOrder, type OrderDocument } from "@x207/core";
import { sandboxAvailable } from "../../../sdk/test-support/sandbox.js";
import { deployCircle, SHORT_PARAMS, type CircleFixture } from "../../../sdk/test-support/circle.js";
import { FailoverRpcClient, Indexer, RpcBlockSource, createApiServer, openDatabase, rpcChainReader } from "../../src/index.js";
import { marketplaceRoutes } from "../../src/marketplace/index.js";
import { signNoticeJson } from "../../src/marketplace/notice.js";

describe.skipIf(!sandboxAvailable)("BE-055 on-chain proofs on near-sandbox", () => {
  let fx: CircleFixture | undefined;
  afterAll(async () => {
    await fx?.stop();
  });

  it("TC-BE-055-S01 the close_epoch of the seller shows as a proof and pays through payForProofs; the one of another account does not count", async () => {
    fx = await deployCircle(SHORT_PARAMS);
    const { sandbox, circle } = fx;
    const keeperA = await sandbox.createAccount("keepera", "10");
    const keeperB = await sandbox.createAccount("keeperb", "10");
    const buyer = await sandbox.createAccount("buyer", "10");
    const rpcUrl = sandbox.rpcUrl;

    // the indexer follows the chain while the flow runs (a sandbox forgets old outcomes after a few epochs of height)
    const startBlock = Number(((await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x", method: "block", params: { finality: "final" } }) })).json()) as { result: { header: { height: number } } }).result.header.height) - 20;
    const db = openDatabase(":memory:");
    const source = new RpcBlockSource(rpcChainReader(new FailoverRpcClient({ endpoints: [rpcUrl], timeoutMs: 30_000 })), circle.accountId, startBlock);
    const indexer = new Indexer({ db, source, circleId: "agents-main", contractId: circle.accountId, startBlock, fetchParams: () => sandbox.view(circle.accountId, "get_params", {}) });
    await indexer.bootstrap();
    const follow = async () => {
      for (let i = 0; i < 20; i++) if ((await indexer.drain(200)) === 0) await new Promise((r) => setTimeout(r, 200));
    };

    // the two parties of the order are members of the circle in the read model (the order book asks for their voucher keys)
    const keys = { [keeperA.accountId]: generateVoucherKeypair(), [buyer.accountId]: generateVoucherKeypair() };
    for (const [account, pair] of Object.entries(keys)) {
      db.prepare(
        `INSERT INTO members (circle_id, account_id, pubkey_voucher, terms_hash, stake, credit_limit, outstanding_debt, status, settled_history, joined_at_ns, updated_block)
         VALUES ('agents-main', ?, ?, ?, 100000000, 80000000, 0, 'active', 0, 1, 1)`,
      ).run(account, pair.publicKey, "a".repeat(64));
    }
    const server = createApiServer({ db, extraRoutes: marketplaceRoutes(db) });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/x207/circles/agents-main`;
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
      return { status: r.status, json: (await r.json()) as any };
    };

    try {
      await follow();
      // the order: a keeper service paid per `close_epoch`, seller keeperA, buyer buyer
      const doc: OrderDocument = {
        circle: circle.accountId, kind: "keeper", buyer: buyer.accountId, seller: keeperA.accountId, spec_hash: "a".repeat(64), nonce: "k1",
        proof: { method: "close_epoch", amount_per_tx: "1000000" }, milestones: [{ amount: "3000000", due_at: Math.floor(Date.now() / 1000) + 86_400 }],
      };
      const sign = (account: string) => ({ account, signature: signNoticeJson(serializeOrder(doc), circle.accountId, keys[account]!.secretKey) });
      expect((await call("POST", "/orders", { order: doc, signatures: [sign(keeperA.accountId), sign(buyer.accountId)] })).status).toBe(201);
      const hash = orderHash(doc);

      // epoch 1 ends: the OTHER account closes it
      const epoch1 = await sandbox.view<{ epoch: number; cutoff_at: string }>(circle.accountId, "get_epoch", {});
      await sandbox.advanceTo(Number(BigInt(epoch1.cutoff_at) / 1_000_000n) + 1000);
      const closedByB = await keeperB.call({ receiverId: circle.accountId, methodName: "close_epoch", args: { epoch: epoch1.epoch }, deposit: 0n });
      expect(closedByB.failures).toEqual([]);
      await follow();
      expect((await call("GET", `/orders/${hash}/onchain-proofs`)).json.items).toEqual([]); // not the seller: no proof

      // epoch 2 ends: the SELLER closes it
      const epoch2 = await sandbox.view<{ epoch: number; cutoff_at: string }>(circle.accountId, "get_epoch", {});
      await sandbox.advanceTo(Number(BigInt(epoch2.cutoff_at) / 1_000_000n) + 1000);
      const closedByA = await keeperA.call({ receiverId: circle.accountId, methodName: "close_epoch", args: { epoch: epoch2.epoch }, deposit: 0n });
      expect(closedByA.failures).toEqual([]);
      await follow();

      const proofs = (await call("GET", `/orders/${hash}/onchain-proofs`)).json;
      expect(proofs.items.map((i: any) => [i.txHash, i.method, i.signer, i.epoch])).toEqual([[closedByA.hash, "close_epoch", keeperA.accountId, epoch2.epoch]]);

      const paid = payForProofs({
        order: doc, epoch: epoch2.epoch + 1, state: { seq: 0, cumulativeAmount: "0" }, alreadyPaid: [], alreadySpent: "0", secretKey: keys[buyer.accountId]!.secretKey,
        proofs: proofs.items.map((i: any) => ({ txHash: i.txHash, method: i.method, signer: i.signer })),
      });
      expect(paid.paid).toEqual([closedByA.hash]);
      expect(paid.vouchers).toHaveLength(1);
      expect(paid.vouchers[0]).toMatchObject({ payer: buyer.accountId, payee: keeperA.accountId, cumulativeAmount: "1000000" });
    } finally {
      server.close();
      db.close();
    }
  }, 600_000);
});
