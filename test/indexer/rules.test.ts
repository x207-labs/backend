import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiServer } from "../../src/api/server.js";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { rebuildReadModel } from "../../src/indexer/rebuild.js";
import type { SourceBlock } from "../../src/indexer/block-source.js";
import { acct, ArrayBlockSource, block, CONTRACT, eventLog, joinLog, stakeLog } from "../helpers/fx-log42.js";

const CIRCLE = "agents-main";
const A = acct("translator");
const B = acct("summarizer");
const HASH = "ab".repeat(32);
const M = 1_000_000;

// The events of interface 0.0.12 as a real chain sends them: `data` is an array with one object (eventLog does that).
const bondLocked = (id: number, who: string, amount = 20 * M) => eventLog("bond_locked", { bundle_id: id, account_id: who, amount: String(amount) });
const disputed = (id: number, complainant: string, accused: string) => eventLog("deal_disputed", { bundle_id: id, complainant, accused, evidence_hash: HASH, disputed_at: "1800000000000000000" });
const ruled = (id: number, verdict: string) => eventLog("deal_ruled", { bundle_id: id, arbiter: "arb.near", verdict });
const slashed = (id: number, from: string, to: string, amount: number, fromStake: number, toStake: number) =>
  eventLog("bond_slashed", { bundle_id: id, from, to, amount: String(amount), from_stake: String(fromStake), to_stake: String(toStake) });
const released = (id: number, who: string, reason: string, amount = 20 * M) => eventLog("bond_released", { bundle_id: id, account_id: who, amount: String(amount), reason });

describe("BE-065 events of interface 0.0.12: deals, freezes, official contracts", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(() => db.close());

  async function ingest(blocks: SourceBlock[]): Promise<void> {
    const ix = new Indexer({ db, source: new ArrayBlockSource(blocks), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000 });
    await ix.bootstrap();
    await ix.drain();
  }
  const all = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).safeIntegers(true).all(...args) as T[];
  const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).safeIntegers(true).get(...args) as T;
  /** Two members with a stake of 100 and a limit of 80, as the contract gives them. */
  const members = (limit = "80000000"): SourceBlock[] => [
    block(1000, { logs: [joinLog("translator"), joinLog("summarizer")] }),
    block(1001, { logs: [stakeLog("translator", "100000000", "100000000", limit), stakeLog("summarizer", "100000000", "100000000", limit)] }),
  ];
  const events = (height: number, ...logs: string[]): SourceBlock => block(height, { logs });
  const stakeLimit = (who: string) => one<{ stake: bigint; credit_limit: bigint }>("SELECT stake, credit_limit FROM members WHERE account_id = ?", who);

  it("TC-BE-065-01 a deal is opened by two locked bonds, disputed, ruled guilty: the bond moves from the stake of the accused to the stake of the complainant and the deal closes", async () => {
    await ingest([...members(), events(1002, bondLocked(7, A), bondLocked(7, B)), events(1003, disputed(7, A, B)),
      events(1004, ruled(7, "accused_guilty"), slashed(7, B, A, 20 * M, 80 * M, 120 * M), released(7, A, "ruling"))]);
    expect(one("SELECT * FROM deals WHERE bundle_id = 7")).toMatchObject({
      party_a: A, party_b: B, bond_each: BigInt(20 * M), locked_a: 0n, locked_b: 0n, state: "closed", complainant: A, accused: B, evidence_hash: HASH, arbiter: "arb.near", verdict: "accused_guilty", closed_block: 1004n,
    });
    expect(stakeLimit(A)).toEqual({ stake: BigInt(120 * M), credit_limit: BigInt(80 * M) });
    expect(stakeLimit(B)).toEqual({ stake: BigInt(80 * M), credit_limit: BigInt(80 * M) });
    expect(all<{ event: string }>("SELECT event FROM deal_events WHERE bundle_id = 7 ORDER BY id").map((e) => e.event)).toEqual(["bond_locked", "bond_locked", "deal_disputed", "deal_ruled", "bond_slashed", "bond_released"]);
  });

  it("TC-BE-065-02 the limit that rule_deal lowers comes in its limits_updated: the limit follows and the history says ruling (a limits_updated of another receipt says finalize)", async () => {
    const limitsUpdated = (account: string, oldLimit: number, newLimit: number) =>
      eventLog("limits_updated", { epoch: 42, changes: [{ account_id: account, old_limit: String(oldLimit), new_limit: String(newLimit), status: "active" }], chunk: 0, chunks: 1 });
    // a limit above the room (what the review calls C-6) is cut to stake - locked by the ruling, and the contract says so
    await ingest([...members("95000000"), events(1002, bondLocked(8, A), bondLocked(8, B)), events(1003, disputed(8, A, B)),
      events(1004, ruled(8, "accused_guilty"), slashed(8, B, A, 20 * M, 80 * M, 120 * M), released(8, A, "ruling"), limitsUpdated(B, 95 * M, 80 * M)),
      events(1005, limitsUpdated(A, 95 * M, 96 * M))]);
    expect(stakeLimit(B)).toEqual({ stake: BigInt(80 * M), credit_limit: BigInt(80 * M) });
    expect(stakeLimit(A)).toEqual({ stake: BigInt(120 * M), credit_limit: BigInt(96 * M) });
    expect(all("SELECT account_id, reason, old_limit, new_limit FROM member_limits WHERE reason != 'stake' ORDER BY id")).toEqual([
      { account_id: B, reason: "ruling", old_limit: BigInt(95 * M), new_limit: BigInt(80 * M) },
      { account_id: A, reason: "finalize", old_limit: BigInt(95 * M), new_limit: BigInt(96 * M) },
    ]);
  });

  it("TC-BE-065-03 confirmation releases the bond of the other party; the deal is closed when nothing is locked; a release by confirmation never changes a limit", async () => {
    await ingest([...members("95000000"), events(1002, bondLocked(9, A), bondLocked(9, B)),
      events(1003, eventLog("deal_confirmed", { bundle_id: 9, account_id: A, of: B }), released(9, B, "confirmed")),
      events(1004, eventLog("deal_confirmed", { bundle_id: 9, account_id: B, of: A }), released(9, A, "confirmed"))]);
    expect(one("SELECT locked_a, locked_b, state, closed_block FROM deals WHERE bundle_id = 9")).toEqual({ locked_a: 0n, locked_b: 0n, state: "closed", closed_block: 1004n });
    expect(stakeLimit(A).credit_limit).toBe(BigInt(95 * M)); // not bounded: only a ruling bounds
  });

  it("TC-BE-065-04 complaint_false: half of the bond of the complainant to the accused, the rest released", async () => {
    await ingest([...members(), events(1002, bondLocked(10, A), bondLocked(10, B)), events(1003, disputed(10, A, B)),
      events(1004, ruled(10, "complaint_false"), slashed(10, A, B, 10 * M, 90 * M, 110 * M), released(10, A, "ruling", 10 * M), released(10, B, "ruling"))]);
    expect(one("SELECT state, verdict, locked_a, locked_b FROM deals WHERE bundle_id = 10")).toEqual({ state: "closed", verdict: "complaint_false", locked_a: 0n, locked_b: 0n });
    expect(stakeLimit(A).stake).toBe(BigInt(90 * M));
    expect(stakeLimit(B).stake).toBe(BigInt(110 * M));
  });

  it("TC-BE-065-05 freeze: proposed is pending with its eta, applied is frozen from an epoch, cancelled and unfrozen remove the row", async () => {
    await ingest([...members(),
      events(1002, eventLog("freeze_proposed", { account_id: A, eta: "1800000000000000000", reason_hash: HASH }), eventLog("freeze_proposed", { account_id: B, eta: "1800000000000000001", reason_hash: null })),
    ]);
    expect(all("SELECT account_id, state, eta_ns, reason_hash FROM member_freezes ORDER BY account_id")).toEqual([
      { account_id: B, state: "pending", eta_ns: 1800000000000000001n, reason_hash: null }, { account_id: A, state: "pending", eta_ns: 1800000000000000000n, reason_hash: HASH },
    ].sort((x, y) => (x.account_id < y.account_id ? -1 : 1)));
    db.close();
    db = openDatabase(":memory:");
    await ingest([...members(), events(1002, eventLog("freeze_proposed", { account_id: A, eta: "1", reason_hash: null }), eventLog("freeze_proposed", { account_id: B, eta: "2", reason_hash: null })),
      events(1003, eventLog("member_frozen", { account_id: A, from_epoch: 42 }), eventLog("freeze_cancelled", { account_id: B }))]);
    expect(all("SELECT account_id, state, from_epoch FROM member_freezes")).toEqual([{ account_id: A, state: "frozen", from_epoch: 42n }]);
    db.close();
    db = openDatabase(":memory:");
    await ingest([...members(), events(1002, eventLog("member_frozen", { account_id: A, from_epoch: 42 })), events(1003, eventLog("member_unfrozen", { account_id: A }))]);
    expect(all("SELECT * FROM member_freezes")).toEqual([]);
  });

  it("TC-BE-065-06 official contracts are set, replaced and cleared by an empty list", async () => {
    await ingest([...members(),
      events(1002, eventLog("asset_contracts_set", { asset_type: "token:nep141", contracts: ["usdc.near", "wnear.near"] })),
      events(1003, eventLog("asset_contracts_set", { asset_type: "nft:nep171", contracts: ["nft.near"] })),
      events(1004, eventLog("asset_contracts_set", { asset_type: "token:nep141", contracts: ["usdc.near"] })),
      events(1005, eventLog("asset_contracts_set", { asset_type: "nft:nep171", contracts: [] }))]);
    expect(all("SELECT asset_type, contracts FROM official_contracts")).toEqual([{ asset_type: "token:nep141", contracts: JSON.stringify(["usdc.near"]) }]);
  });

  it("TC-BE-065-07 a rebuild from events_raw gives the same deals, freezes and stakes (the read model is replayable)", async () => {
    await ingest([...members(), events(1002, bondLocked(7, A), bondLocked(7, B), eventLog("member_frozen", { account_id: B, from_epoch: 3 })), events(1003, disputed(7, A, B)),
      events(1004, ruled(7, "accused_guilty"), slashed(7, B, A, 20 * M, 80 * M, 120 * M), released(7, A, "ruling"))]);
    const snapshot = () => JSON.stringify([all("SELECT * FROM deals"), all("SELECT * FROM deal_events ORDER BY id"), all("SELECT * FROM member_freezes"), all("SELECT account_id, stake, credit_limit FROM members ORDER BY account_id")], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const before = snapshot();
    rebuildReadModel(db, CIRCLE);
    expect(snapshot()).toBe(before);
  });

  describe("read routes", () => {
    async function serve() {
      await ingest([...members(), events(1002, bondLocked(7, A), bondLocked(7, B), bondLocked(8, A, 5 * M), bondLocked(8, acct("image"), 5 * M)),
        events(1003, disputed(7, A, B)), events(1004, eventLog("freeze_proposed", { account_id: B, eta: "1800000000000000000", reason_hash: HASH })),
        events(1005, eventLog("member_frozen", { account_id: A, from_epoch: 5 }), eventLog("asset_contracts_set", { asset_type: "token:nep141", contracts: ["usdc.near"] }))]);
      const server = createApiServer({ db });
      await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/x207/circles/${CIRCLE}`;
      return { base, close: () => server.close() };
    }
    const get = async (base: string, path: string) => {
      const r = await fetch(base + path);
      return { status: r.status, json: (await r.json()) as any };
    };

    it("TC-BE-065-08 deals: list by account and state with the bond locked now, one deal with its history, unknown deal", async () => {
      const s = await serve();
      try {
        const list = await get(s.base, `/deals?account=${A}`);
        expect(list.json).toMatchObject({ account: A, bondLocked: String(25 * M), unit: "credit", decimals: 6 });
        expect(list.json.items.map((d: any) => [d.bundleId, d.state])).toEqual([[8, "open"], [7, "disputed"]]);
        expect((await get(s.base, "/deals?state=disputed")).json.items.map((d: any) => d.bundleId)).toEqual([7]);
        const deal = (await get(s.base, "/deals/7")).json;
        expect(deal).toMatchObject({ bundleId: 7, parties: [A, B], bondEach: String(20 * M), locked: [true, true], state: "disputed", complainant: A, accused: B, evidenceHash: HASH });
        expect(deal.history.map((h: any) => h.event)).toEqual(["bond_locked", "bond_locked", "deal_disputed"]);
        expect((await get(s.base, "/deals/99")).json.error.code).toBe("deal_not_found");
        expect((await get(s.base, "/deals?state=nope")).status).toBe(400);
        expect((await get(s.base, "/deals?account=Bad%20Account")).status).toBe(400);
      } finally {
        s.close();
      }
    });

    it("TC-BE-065-09 freeze status: pending with its eta, frozen from an epoch, and not frozen is an answer (is_frozen false), unknown member 404; the official contracts", async () => {
      const s = await serve();
      try {
        expect((await get(s.base, `/members/${B}/freeze`)).json).toMatchObject({ account: B, state: "pending", frozen: false, reasonHash: HASH, fromEpoch: null });
        expect((await get(s.base, `/members/${A}/freeze`)).json).toMatchObject({ account: A, state: "frozen", frozen: true, fromEpoch: 5 });
        expect((await get(s.base, `/members/${acct("image")}/freeze`)).status).toBe(404);
        expect((await get(s.base, "/freezes?state=frozen")).json.items.map((f: any) => f.account)).toEqual([A]);
        expect((await get(s.base, "/freezes")).json.items).toHaveLength(2);
        expect((await get(s.base, "/asset-contracts")).json.items).toEqual([{ assetType: "token:nep141", contracts: ["usdc.near"], block: 1005 }]);
      } finally {
        s.close();
      }
    });
  });
});
