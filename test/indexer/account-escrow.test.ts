// BE-110 (P1, contract 0.0.18): the events `account_escrow_held` and `member_removed`, the delivery of an account escrow (reputation reset, key of the member), and the read of the wait.
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { marketplaceRoutes } from "../../src/marketplace/index.js";
import { acct, ArrayBlockSource, block, CONTRACT, eventLog, nsOf } from "../helpers/fx-log42.js";
import { listen, type TestServer } from "../helpers/d9-fixtures.js";
import type { SourceBlock } from "../../src/indexer/block-source.js";

const CIRCLE = "agents-main";
const V = "0.0.18";
const KEY = (n: string): string => `ed25519:${n}`;
const join = (name: string) => eventLog("member_joined", { account_id: acct(name), pubkey_voucher: KEY(name), terms_hash: "a".repeat(64), status: "pending", joined_at: nsOf("2026-11-09T08:00:00Z") });
const stake = (name: string) => eventLog("stake_added", { account_id: acct(name), sender_id: acct(name), amount: "50000000", stake: "50000000", limit: "40000000", status: "active" });
const admit = (name: string) => eventLog("member_admitted", { account_id: acct(name), status: "active" });
const offer = (id: number, type: string, grantor: string) =>
  eventLog("grant_offered", { grant_id: id, asset_type: type, grantor: acct(grantor), class: "A", unit: "once", unit_price: "10000000", expires_at: "1795000000000000000" }, "0.0.7");
const held = (id: number, account: string) => eventLog("account_escrow_held", { grant_id: id, account_id: account }, V);
const activated = (id: number, grantee: string, key: string | null) => eventLog("grant_activated", { grant_id: id, grantee, delivery_pubkey: key }, "0.0.7");
const revoked = (id: number) => eventLog("grant_revoked", { grant_id: id, reason: "grantor" }, "0.0.7");
const removed = (name: string) => eventLog("member_removed", { account_id: acct(name), by_owner: true }, V);

describe("BE-110 account escrow in the read model", () => {
  let db: Database.Database;
  let srv: TestServer | undefined;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
    db.close();
  });

  /** Blocks 1000.. : members seller, sold (admitted, with stake) and buyer; the grants are offered by `seller`. */
  const setup = (...later: SourceBlock[]): SourceBlock[] => [
    block(1000, { logs: [join("seller"), join("sold"), join("buyer"), join("pending")] }),
    block(1001, { logs: [stake("seller"), stake("sold"), stake("buyer")] }),
    block(1002, { logs: [admit("seller"), admit("sold"), admit("buyer")] }),
    ...later,
  ];

  async function ingest(blocks: SourceBlock[]): Promise<void> {
    const ix = new Indexer({ db, source: new ArrayBlockSource(blocks), circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000 });
    await ix.bootstrap();
    await ix.drain();
  }
  const escrow = (id: number) => db.prepare("SELECT account_id, state, new_owner FROM account_escrows WHERE circle_id = ? AND grant_id = ?").get(CIRCLE, id);

  it("TC-BE-110-20 account_escrow_held is stored once, under the grant; a replay changes nothing", async () => {
    await ingest(setup(block(1003, { logs: [offer(1, "near:named-account", "seller"), held(1, "old-shop.testnet")] })));
    expect(escrow(1)).toEqual({ account_id: "old-shop.testnet", state: "held", new_owner: null });
    expect((db.prepare("SELECT locked_at_ns AS ns FROM account_escrows WHERE grant_id = 1").get() as { ns: number }).ns).toBe(1003 * 1_000_000_000);
    await ingest([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM account_escrows").get()).toEqual({ n: 1 });
  });

  it("TC-BE-110-21 delivery: the escrow is delivered to the buyer, and the reputation of the account starts again from that block", async () => {
    await ingest(setup(block(1003, { logs: [offer(1, "near:named-account", "seller"), held(1, "old-shop.testnet")] }), block(1004, { logs: [activated(1, "new-owner.testnet", KEY("new-owner"))] })));
    expect(escrow(1)).toEqual({ account_id: "old-shop.testnet", state: "delivered", new_owner: "new-owner.testnet" });
    expect(db.prepare("SELECT account_id, new_owner, since_ms FROM reputation_resets").all()).toEqual([{ account_id: "old-shop.testnet", new_owner: "new-owner.testnet", since_ms: 1004 * 1000 }]);
  });

  it("TC-BE-110-22 a cancelled sale (the grantor took the account back) leaves no reset", async () => {
    await ingest(setup(block(1003, { logs: [offer(1, "near:named-account", "seller"), held(1, "old-shop.testnet")] }), block(1004, { logs: [revoked(1)] })));
    expect(escrow(1)).toMatchObject({ state: "cancelled" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM reputation_resets").get()).toEqual({ n: 0 });
  });

  it("TC-BE-110-23 a member account that is delivered gets the key of the buyer as its voucher key (the key of the seller must stop working, ADR 1.4)", async () => {
    await ingest(setup(block(1003, { logs: [offer(2, "near:member_account", "seller"), held(2, acct("sold"))] }), block(1004, { logs: [activated(2, "new-owner.testnet", KEY("buyer-new"))] })));
    expect(db.prepare("SELECT pubkey_voucher FROM members WHERE account_id = ?").get(acct("sold"))).toEqual({ pubkey_voucher: KEY("buyer-new") });
    // the other members keep theirs
    expect(db.prepare("SELECT pubkey_voucher FROM members WHERE account_id = ?").get(acct("buyer"))).toEqual({ pubkey_voucher: KEY("buyer") });
  });

  it("TC-BE-110-24 an ordinary grant (no account escrow) neither resets a reputation nor touches a key", async () => {
    await ingest(setup(block(1003, { logs: [offer(3, "nft:nep171", "seller")] }), block(1004, { logs: [activated(3, acct("buyer"), KEY("other"))] })));
    expect(db.prepare("SELECT COUNT(*) AS n FROM reputation_resets").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT pubkey_voucher FROM members WHERE account_id = ?").get(acct("buyer"))).toEqual({ pubkey_voucher: KEY("buyer") });
  });

  it("TC-BE-110-25 member_removed deletes a pending member and nobody else; a replay finds nothing", async () => {
    await ingest(setup(block(1003, { logs: [removed("pending"), removed("sold")] })));
    const ids = (db.prepare("SELECT account_id FROM members ORDER BY account_id").all() as Array<{ account_id: string }>).map((r) => r.account_id);
    expect(ids).toEqual([acct("buyer"), acct("seller"), acct("sold")]);
    await ingest([]);
  });

  async function market(open: number) {
    srv = await listen({ db, extraRoutes: marketplaceRoutes(db, { chainView: () => Promise.resolve({ epoch: open, phase: "open" }) }) });
    return (path: string) => fetch(`${srv!.url}/x207/circles/${CIRCLE}${path}`).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  }
  const epochRow = (epoch: number, phase: string, closedSeconds: number | null) =>
    db.prepare("INSERT INTO epochs (circle_id, epoch, phase, closed_at_ns) VALUES (?, ?, ?, ?)").run(CIRCLE, epoch, phase, closedSeconds === null ? null : closedSeconds * 1_000_000_000);

  it("TC-BE-110-26 a named account needs no wait: it is ready as soon as it is held", async () => {
    await ingest(setup(block(1003, { logs: [offer(1, "near:named-account", "seller"), held(1, "old-shop.testnet")] })));
    const get = await market(7);
    const r = await get("/account-escrows/1");
    expect(r).toMatchObject({ status: 200, json: { grantId: 1, account: "old-shop.testnet", assetType: "near:named-account", state: "held", member: false, waitOver: true, ready: true, reputationResetAt: null } });
  });

  it("TC-BE-110-27 a member account waits: not ready in the epoch of the lock, not ready while the locked epoch is not finalized, ready after", async () => {
    await ingest(setup(block(1003, { logs: [offer(2, "near:member_account", "seller"), held(2, acct("sold"))] })));
    epochRow(7, "open", null);
    let get = await market(7);
    let r = await get("/account-escrows/2");
    expect(r.json).toMatchObject({ member: true, lockedEpoch: 7, openEpoch: 7, waitOver: false, ready: false });
    await srv!.close();
    // epoch 7 closed after the lock (second 1500 > 1003), epoch 8 is open, but 7 is still in its payment window
    db.prepare("UPDATE epochs SET phase = 'payment_window', closed_at_ns = ? WHERE epoch = 7").run(1500 * 1_000_000_000);
    epochRow(8, "open", null);
    get = await market(8);
    r = await get("/account-escrows/2");
    expect(r.json).toMatchObject({ lockedEpoch: 7, openEpoch: 8, lockedEpochFinalized: false, waitOver: false, ready: false });
    await srv!.close();
    db.prepare("UPDATE epochs SET phase = 'finalized' WHERE epoch = 7").run();
    get = await market(8);
    r = await get("/account-escrows/2");
    expect(r.json).toMatchObject({ lockedEpoch: 7, openEpoch: 8, lockedEpochFinalized: true, waitOver: true, ready: true });
  });

  it("TC-BE-110-30 a member account is not ready while an epoch before the open one is not finalized, even when the locked epoch is (CT-126)", async () => {
    await ingest(setup(block(1003, { logs: [offer(2, "near:member_account", "seller"), held(2, acct("sold"))] })));
    epochRow(6, "payment_window", 100);
    epochRow(7, "finalized", 1500);
    epochRow(8, "open", null);
    const get = await market(8);
    expect((await get("/account-escrows/2")).json).toMatchObject({ lockedEpoch: 7, lockedEpochFinalized: true, waitOver: false, ready: false });
    await srv!.close();
    db.prepare("UPDATE epochs SET phase = 'finalized' WHERE epoch = 6").run();
    const again = await market(8);
    expect((await again("/account-escrows/2")).json).toMatchObject({ waitOver: true, ready: true });
  });

  it("TC-BE-110-31 the list of account escrows, newest first, filtered by state; a bad state is 400", async () => {
    await ingest(setup(block(1003, { logs: [offer(1, "near:named-account", "seller"), held(1, "old-shop.testnet"), offer(2, "near:account", "seller"), held(2, "other.testnet")] }), block(1004, { logs: [activated(1, "new-owner.testnet", null)] })));
    const get = await market(7);
    expect((await get("/account-escrows")).json.items.map((i: { grantId: number }) => i.grantId)).toEqual([2, 1]);
    expect((await get("/account-escrows?state=held")).json.items).toEqual([{ grantId: 2, account: "other.testnet", state: "held", newOwner: null }]);
    expect((await get("/account-escrows?state=bogus")).status).toBe(400);
  });

  it("TC-BE-110-28 after delivery the read says delivered, not ready, and when the reputation restarted; an unknown or bad grant id is 404", async () => {
    await ingest(setup(block(1003, { logs: [offer(1, "near:named-account", "seller"), held(1, "old-shop.testnet")] }), block(1004, { logs: [activated(1, "new-owner.testnet", null)] })));
    const get = await market(7);
    const r = await get("/account-escrows/1");
    expect(r.json).toMatchObject({ state: "delivered", ready: false, newOwner: "new-owner.testnet", reputationResetAt: "1970-01-01T00:16:44Z" });
    expect((await get("/account-escrows/99")).json.error.code).toBe("account_escrow_not_found");
    expect((await get("/account-escrows/abc")).status).toBe(404);
  });

  it("TC-BE-110-29 reputation restarts when the account is sold: deals before the sale no longer count, deals after it do", async () => {
    await ingest(setup(block(1003, { logs: [offer(2, "near:member_account", "seller"), held(2, acct("sold"))] })));
    const deal = (n: number, buyer: string, matchedMs: number) => {
      const hash = n.toString(16).padStart(64, "0");
      db.prepare(
        `INSERT INTO matches (circle_id, listing_hash, offer_hash, seller, counterparty, mode, kind, epoch, terms_hash, listing_value, discount_value, searcher_account, searcher_value, matched_at_ms)
         VALUES (?, ?, ?, ?, ?, 'pay', 'payment', 42, NULL, '100000000', '10000000', NULL, '0', ?)`,
      ).run(CIRCLE, hash, hash, acct("sold"), acct(buyer), matchedMs);
      db.prepare("INSERT OR REPLACE INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, cleared, registration_mode, registered_block, receipt_id) VALUES (?, 42, ?, ?, 1, 90000000, NULL, 'cumulative', 1, 'r')").run(CIRCLE, acct(buyer), acct("sold"));
    };
    const get = await market(7); // mounting the routes applies the marketplace tables
    epochRow(42, "open", null);
    deal(1, "seller", 500_000);
    expect((await get(`/reputation/${acct("sold")}`)).json).toMatchObject({ completed: { counterparties: 1 }, resetAt: null });
    await srv!.close();
    await ingest([block(1004, { logs: [activated(2, "new-owner.testnet", KEY("buyer-new"))] })]);
    deal(2, "buyer", 2_000_000);
    const after = await (await market(7))(`/reputation/${acct("sold")}`);
    expect(after.json).toMatchObject({ completed: { counterparties: 1 }, resetAt: "1970-01-01T00:16:44Z" });
    // without the reset both deals would count
    db.prepare("DELETE FROM reputation_resets").run();
    await srv!.close();
    const without = await (await market(7))(`/reputation/${acct("sold")}`);
    expect(without.json).toMatchObject({ completed: { counterparties: 2 } });
  });
});
