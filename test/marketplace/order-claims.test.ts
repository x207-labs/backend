import { afterEach, describe, expect, it } from "vitest";
import { mandateHash, orderClaimNotice, orderHash, payForProofs, signOrderClaim, type DelegateMandate, type OnchainProof } from "@x207/core";
import type { ClaimRpc } from "../../src/marketplace/order-claims.js";
import { acct, CONTRACT, NOW, NOW_S, startMarket, type Market } from "./helpers.js";
import { H, orderDoc, signOrder } from "./order-helpers.js";

const DAO = "venear.sputnik-dao.near";
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");
const TX = (n: number): string => `Tx${"ABCDEFGHJKLMNPQRSTUVWXYZ"[n]}${"A".repeat(39)}`;

describe("BE-055 fix: claims of the votes of a delegate order (SD-072)", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  const mandate: DelegateMandate = { circle: CONTRACT, dao: DAO, kinds: ["transfer", "vote"], rules_hash: H("b") };
  const delegate = (over: Record<string, unknown> = {}) =>
    orderDoc("andi", "budi", { kind: "delegate", proof: { method: "act_proposal", amount_per_tx: "1000000" }, mandate_hash: mandateHash(mandate), milestones: [{ amount: "5000000", due_at: NOW_S + 86_400 }], ...over } as never);

  /** A mock chain: transactions by hash, the block time of each block, and the kind of each proposal; counts the reads. */
  function chain() {
    const txs = new Map<string, unknown>();
    const kinds = new Map<number, unknown>();
    const reads = { view: 0, tx: 0 };
    const rpc: ClaimRpc = {
      tx: async (h) => (reads.tx++, txs.get(h) ?? null),
      blockTimestampNs: async (b) => BigInt(b.startsWith("old") ? NOW - 3_600_000 : NOW + 1000) * 1_000_000n,
    };
    const view = async (_c: string, method: string, args: Record<string, unknown>) => {
      if (method !== "get_proposal") return null; // the open epoch of the circle
      reads.view++;
      return { id: args.id, kind: kinds.get(args.id as number) };
    };
    const vote = (h: string, o: { signer?: string; receiver?: string; id?: number; action?: string; method?: string; fail?: boolean; actions?: number; block?: string } = {}) =>
      txs.set(h, {
        status: o.fail ? { Failure: {} } : { SuccessValue: "" },
        transaction: { signer_id: o.signer ?? acct("budi"), receiver_id: o.receiver ?? DAO, actions: Array.from({ length: o.actions ?? 1 }, () => ({ FunctionCall: { method_name: o.method ?? "act_proposal", args: b64({ id: o.id ?? 1, action: o.action ?? "VoteApprove" }) } })) },
        transaction_outcome: { block_hash: o.block ?? "blk" },
        receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
      });
    return { rpc, view, txs, kinds, reads, vote };
  }

  async function start() {
    const c = chain();
    market = await startMarket(["andi", "budi", "citra"], [], c.view, { claimRpc: c.rpc });
    return { m: market, c };
  }
  const create = async (m: Market, doc = delegate(), body: Record<string, unknown> = { mandate }) => {
    const sign = (who: string) => { try { return signOrder(m, doc as never, who); } catch { return { account: acct(who), signature: "x" }; } };
    const res = await m.post("/orders", { order: doc, signatures: [sign("andi"), sign("budi")], ...body });
    let hash = ""; try { hash = orderHash(doc as never); } catch { /* a bad document has no hash */ }
    return { res, hash };
  };
  const claim = (m: Market, hash: string, tx: string, who = "budi", over: Record<string, unknown> = {}) => {
    const n = orderClaimNotice({ circle: CONTRACT, orderHash: hash, actor: acct(who), at: NOW_S, txHash: tx });
    return m.post(`/orders/${hash}/claims`, { tx_hash: tx, notice: { ...n, ...over }, signature: signOrderClaim(n, m.keys[who]!.secretKey) });
  };
  const reason = (r: { status: number; json: any }) => [r.status, r.json.error?.code, r.json.error?.details?.reason];

  it("TC-BE-055-10 a vote of the seller on the DAO of the mandate is accepted and listed with receiver, proposal, action and kind; the list feeds payForProofs", async () => {
    const { m, c } = await start();
    const { res, hash } = await create(m);
    expect(res.status).toBe(201);
    expect(res.json.mandate).toEqual(mandate);
    c.kinds.set(1, { Transfer: {} }); c.kinds.set(2, "Vote");
    c.vote(TX(1), { id: 1 }); c.vote(TX(2), { id: 2, action: "VoteReject" });
    expect((await claim(m, hash, TX(1))).status).toBe(201);
    expect((await claim(m, hash, TX(2))).json).toMatchObject({ proposalId: 2, action: "VoteReject", proposalKind: "vote" });
    const list = await m.get(`/orders/${hash}/onchain-proofs`);
    expect(list.status).toBe(200);
    expect(list.json.items.map((i: any) => [i.txHash, i.signer, i.receiver, i.proposalId, i.action, i.proposalKind, i.method])).toEqual([
      [TX(1), acct("budi"), DAO, 1, "VoteApprove", "transfer", "act_proposal"],
      [TX(2), acct("budi"), DAO, 2, "VoteReject", "vote", "act_proposal"],
    ]);
    const proofs: OnchainProof[] = list.json.items.map((i: any) => ({ txHash: i.txHash, method: i.method, signer: i.signer, receiver: i.receiver, proposal_id: i.proposalId, action: i.action, proposal_kind: i.proposalKind }));
    const out = payForProofs({ order: delegate() as never, epoch: 42, state: { seq: 0, cumulativeAmount: "0" }, proofs, alreadyPaid: [], alreadySpent: "0", secretKey: m.keys.andi!.secretKey, mandate });
    expect(out.paid).toEqual([TX(1), TX(2)]);
  });

  it("TC-BE-055-11 Finalize and other actions are not votes", async () => {
    const { m, c } = await start();
    const { hash } = await create(m);
    c.kinds.set(1, "Vote");
    for (const action of ["Finalize", "VoteRemove", "AddProposal"]) {
      c.vote(TX(3), { action });
      expect(reason(await claim(m, hash, TX(3))), action).toEqual([400, "claim_invalid", "not_a_vote"]);
    }
    c.vote(TX(4), { actions: 2 });
    expect(reason(await claim(m, hash, TX(4)))).toEqual([400, "claim_invalid", "not_a_vote"]);
    c.vote(TX(5), { method: "add_proposal" });
    expect(reason(await claim(m, hash, TX(5)))).toEqual([400, "claim_invalid", "not_a_vote"]);
    expect((await m.get(`/orders/${hash}/onchain-proofs`)).json.items).toEqual([]);
  });

  it("TC-BE-055-12 a second vote on the same proposal and the same transaction twice are already_claimed", async () => {
    const { m, c } = await start();
    const { hash } = await create(m);
    c.kinds.set(1, "Vote");
    c.vote(TX(6), { id: 1 }); c.vote(TX(7), { id: 1, action: "VoteReject" });
    expect((await claim(m, hash, TX(6))).status).toBe(201);
    expect(reason(await claim(m, hash, TX(7)))).toEqual([400, "claim_invalid", "already_claimed"]); // same proposal
    expect(reason(await claim(m, hash, TX(6)))).toEqual([400, "claim_invalid", "already_claimed"]); // same transaction
    expect((await m.get(`/orders/${hash}/onchain-proofs`)).json.items).toHaveLength(1);
  });

  it("TC-BE-055-13 a proposal of a kind outside the mandate is refused", async () => {
    const { m, c } = await start();
    const { hash } = await create(m);
    c.kinds.set(1, { FunctionCall: {} }); c.vote(TX(8), { id: 1 });
    const r = await claim(m, hash, TX(8));
    expect(reason(r)).toEqual([400, "claim_invalid", "kind_not_in_mandate"]);
    expect(r.json.error.details).toMatchObject({ proposal_kind: "function_call", allowed: ["transfer", "vote"] });
  });

  it("TC-BE-055-14 a signer that is not the seller, another receiver, a failed transaction, a vote before the order, an unknown transaction are refused", async () => {
    const { m, c } = await start();
    const { hash } = await create(m);
    c.kinds.set(1, "Vote");
    c.vote(TX(9), { signer: acct("citra") });
    expect(reason(await claim(m, hash, TX(9)))).toEqual([400, "claim_invalid", "wrong_signer"]);
    c.vote(TX(10), { receiver: "other.sputnik-dao.near" });
    expect(reason(await claim(m, hash, TX(10)))).toEqual([400, "claim_invalid", "wrong_receiver"]);
    c.vote(TX(11), { fail: true });
    expect(reason(await claim(m, hash, TX(11)))).toEqual([400, "claim_invalid", "tx_failed"]);
    c.vote(TX(12), { block: "old-block" });
    expect(reason(await claim(m, hash, TX(12)))).toEqual([400, "claim_invalid", "before_order"]);
    expect(reason(await claim(m, hash, TX(13)))).toEqual([400, "claim_invalid", "tx_not_found"]);
    expect((await m.get(`/orders/${hash}/onchain-proofs`)).json.items).toEqual([]);
  });

  it("TC-BE-055-15 only the seller claims, with a valid signature, on a delegate order that is open", async () => {
    const { m, c } = await start();
    const { hash } = await create(m);
    c.kinds.set(1, "Vote"); c.vote(TX(14));
    expect((await claim(m, hash, TX(14), "andi")).json.error.code).toBe("order_not_party"); // the buyer
    expect((await claim(m, hash, TX(14), "citra")).json.error.code).toBe("order_not_party");
    const n = orderClaimNotice({ circle: CONTRACT, orderHash: hash, actor: acct("budi"), at: NOW_S, txHash: TX(14) });
    expect((await m.post(`/orders/${hash}/claims`, { notice: n, signature: signOrderClaim(n, m.keys.citra!.secretKey) })).json.error.code).toBe("invalid_signature");
    expect((await claim(m, hash, TX(14), "budi", { at: NOW_S + 5000 })).status).toBe(400);
    const keeper = orderDoc("andi", "budi", { kind: "keeper", proof: { method: "close_epoch", amount_per_tx: "1000000" }, milestones: [{ amount: "5000000", due_at: NOW_S + 86_400 }] });
    const k = await create(m, keeper as never, {});
    expect((await claim(m, k.hash, TX(14))).json.error.code).toBe("order_not_proof_kind");
  });

  it("TC-BE-055-16 a delegate order needs a mandate whose hash is order.mandate_hash; other kinds refuse a mandate", async () => {
    const { m } = await start();
    expect((await create(m, delegate(), {})).res.json.error.code).toBe("order_mandate_required");
    expect((await create(m, delegate(), { mandate: { ...mandate, rules_hash: H("c") } })).res.json.error.code).toBe("order_bad_mandate");
    expect((await create(m, delegate(), { mandate: { ...mandate, circle: acct("x") } })).res.json.error.code).toBe("order_bad_mandate");
    expect((await create(m, delegate({ mandate_hash: "zz" }), { mandate })).res.json.error.code).toBe("order_bad_mandate");
    expect((await create(m, orderDoc("andi", "budi"), { mandate })).res.json.error.code).toBe("order_mandate_forbidden");
    expect((await create(m, delegate(), { mandate: { ...mandate, kinds: [...mandate.kinds].reverse() } })).res.status).toBe(201); // kinds are sorted, so the hash is the same
  });

  it("TC-BE-055-17 the kind of a proposal is read once per proposal", async () => {
    const { m, c } = await start();
    const { hash } = await create(m);
    c.kinds.set(1, "Vote");
    c.vote(TX(15), { id: 1 }); c.vote(TX(16), { id: 1 });
    await claim(m, hash, TX(15));
    expect(c.reads.view).toBe(1);
    const second = delegate({ nonce: "n2" });
    const b = await create(m, second);
    await claim(m, b.hash, TX(16)); // same proposal, another order: the kind comes from the cache
    expect(c.reads.view).toBe(1);
  });

  it("TC-BE-055-18 without a configured RPC the claim is refused, not accepted", async () => {
    market = await startMarket(["andi", "budi"]);
    const { hash } = await create(market);
    expect(reason(await claim(market, hash, TX(17)))).toEqual([503, "claim_rpc_unavailable", undefined]);
  });
});
