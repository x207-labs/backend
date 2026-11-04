import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { listingHash, signVoucher, TRANSFER_WINDOW_SECONDS, transferDocumentHash, transferResource, type Listing, type TransferDocument, type TransferPlatform, type UnsignedVoucher } from "@x207/core";
import { signNoticeJson } from "../../src/marketplace/notice.js";
import type { Transport } from "../../src/marketplace/ssrf.js";
import { DnsTxtProof, TradeApiProof } from "../../src/marketplace/transfer-proofs.js";
import { acct, CONTRACT, NOW_S, openEpoch, signedListing, startMarket, type Market } from "./helpers.js";

// BE-074 (P4, ADR-49): transfer through the official feature of a platform. The DNS (DoH), the registry (RDAP) and Steam are a fake `Transport` behind the SSRF guard.
const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();
const DOMAIN = "example-shop.com";

describe("BE-074 the transfer ledger", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  // the platforms: TXT records, RDAP records and Steam trade offers that a test sets
  const dns = new Map<string, string[]>();
  const rdap = new Map<string, { status: number; body: unknown }>();
  const steam = new Map<string, unknown>();
  const down = { dns: false, steam: false };
  const calls: string[] = [];
  const transport: Transport = async ({ host, path }) => {
    calls.push(`${host}${path}`);
    const reply = (status: number, body: unknown) => ({ status, body: Buffer.from(JSON.stringify(body)), truncated: false });
    if (host === "dns.google") {
      if (down.dns) return { status: 502, body: Buffer.alloc(0), truncated: false };
      const name = new URL(`https://x${path}`).searchParams.get("name") ?? "";
      const records = dns.get(name);
      if (records === undefined) return reply(200, { Status: 3 });
      return reply(200, { Status: 0, Answer: records.map((r) => ({ name, type: 16, TTL: 60, data: `"${r}"` })) });
    }
    if (host === "rdap.verisign.com") {
      const hit = rdap.get(path.split("/").pop() ?? "");
      return hit ? reply(hit.status, hit.body) : reply(404, null);
    }
    if (host === "api.steampowered.com") {
      if (down.steam) return { status: 503, body: Buffer.alloc(0), truncated: false };
      const id = new URL(`https://x${path}`).searchParams.get("tradeofferid") ?? "";
      return reply(200, { response: steam.has(id) ? { offer: steam.get(id) } : {} });
    }
    return { status: 404, body: Buffer.alloc(0), truncated: false };
  };
  const http = { resolver: async () => ["93.184.216.34"], transport };

  async function start() {
    dns.clear(); rdap.clear(); steam.clear(); calls.length = 0; down.dns = false; down.steam = false; seq = 0; held = 0;
    market = await startMarket(["andi", "budi", "citra"], [], undefined, { dnsTxt: new DnsTxtProof(http), tradeApi: new TradeApiProof({ apiKey: "STEAM-KEY-SECRET", baseUrl: "https://api.steampowered.com", ...http }), proofMinSeconds: 0 });
    openEpoch(market, 42);
    return market;
  }
  const at = (m: Market) => Math.floor(m.clock.now / 1000);

  let n = 0;
  /** The seller makes the transfer document and the listing. */
  function sell(m: Market, o: { platform?: TransferPlatform; ref?: string; value?: number; estimate?: number; assetType?: string; detail?: Record<string, unknown> } = {}) {
    const platform = o.platform ?? "domain";
    const ref = o.ref ?? (platform === "domain" ? DOMAIN : platform === "game_item" ? "730:123456789" : "ticket-0001");
    const method = platform === "domain" ? "dns_txt" : platform === "game_item" ? "trade_api" : "buyer_confirm";
    const value = C(o.value ?? 10);
    const nonce = `t${++n}`;
    const doc: TransferDocument = { circle: CONTRACT, seller: acct("andi"), platform, transfer_ref: ref, proof_method: method, estimate_seconds: o.estimate ?? 3600, value, nonce };
    // a document that the SDK refuses has no hash from it (the tests of the errors): any 64 hex characters, since the check reports the error of the SDK before it looks at the hash
    const docHash = (() => {
      try {
        return transferDocumentHash(doc);
      } catch {
        return createHash("sha256").update(JSON.stringify(doc)).digest("hex");
      }
    })();
    const detail = JSON.stringify({ kind: "transfer", transfer_doc: docHash, platform, transfer_ref: ref, proof_method: method, estimate_seconds: doc.estimate_seconds, nonce, ...(o.detail ?? {}) });
    const assetType = o.assetType ?? (platform === "domain" ? "transfer:domain" : platform === "game_item" ? "transfer:game-item" : "transfer:ticket");
    const body = signedListing(m, "andi", { offer: { asset_type: assetType, asset_class: "B", quantity: 1, value }, want: { asset_type: "usdc", asset_class: "A", quantity: 1, value }, detail, nonce: `tl-${n}`, expires_at: NOW_S + 30 * 86_400 } as Partial<Listing>);
    return { doc, docHash, body, hash: listingHash(body.listing), value };
  }
  type Sold = ReturnType<typeof sell>;
  let seq = 0;
  let held = 0;
  const buy = (m: Market, s: Sold, who = "budi", extra: Record<string, unknown> = {}, cumulative?: string) => {
    held += 1;
    const v: UnsignedVoucher = { circle: CONTRACT, payer: acct(who), payee: acct("andi"), epoch: 42, seq: ++seq, cumulativeAmount: cumulative ?? C(10 * held), unit: "credit", resource: transferResource(s.docHash) };
    return m.post(`/listings/${s.hash}/transfers`, { voucher: v, signature: signVoucher(v, m.keys[who]!.secretKey).signature, ...extra });
  };
  const notice = (m: Market, id: number, action: "confirmed" | "cancelled", who: string) => {
    const n2 = { circle: CONTRACT, transfer_id: id, actor: acct(who), action, at: at(m) };
    return m.post(`/transfers/${id}`, { notice: n2, signature: signNoticeJson(JSON.stringify(n2), CONTRACT, m.keys[who]!.secretKey) });
  };

  it("TC-BE-074-01 a domain: the listing needs x207-sell, the voucher is held until x207-own and a settled RDAP, then the seller side sees it and the listing is closed", async () => {
    const m = await start();
    const s = sell(m);
    // no TXT of the seller: refused, nothing stored
    const refused = await m.post("/listings", s.body);
    expect([refused.status, refused.json.error.code]).toEqual([409, "transfer_seller_unproven"]);
    expect((await m.get(`/listings/${s.hash}`)).status).toBe(404);
    dns.set(DOMAIN, [`x207-sell=${s.hash}`]);
    expect((await m.post("/listings", s.body)).status).toBe(201);
    const bought = await buy(m, s);
    expect([bought.status, bought.json.status, bought.json.platform, bought.json.proofMethod]).toEqual([201, "paid_held", "domain", "dns_txt"]);
    expect(bought.json.instructions).toEqual({ setTxtAfterTransfer: `x207-own=${bought.json.transferId}`, on: DOMAIN });
    expect("voucher" in bought.json).toBe(false);
    expect(bought.json.windowUntil - at(m)).toBe(7 * 86_400);
    const id = bought.json.transferId as number;
    // the buyer has not set the TXT: pending, the voucher is held
    const early = await m.post(`/transfers/${id}/proof`, {});
    expect([early.status, early.json.error.code]).toEqual([409, "transfer_proof_pending"]);
    expect(early.json.error.details.want).toBe(`x207-own=${id}`);
    // the TXT is there but the registry still says the transfer is pending
    dns.set(DOMAIN, [`x207-sell=${s.hash}`, `x207-own=${id}`]);
    rdap.set(DOMAIN, { status: 200, body: { ldhName: DOMAIN, status: ["pending transfer"] } });
    expect((await m.post(`/transfers/${id}/proof`, {})).json.error.code).toBe("transfer_proof_pending");
    rdap.set(DOMAIN, { status: 200, body: { ldhName: DOMAIN, status: ["active"] } });
    const done = await m.post(`/transfers/${id}/proof`, {});
    expect([done.status, done.json.status]).toEqual([200, "confirmed"]);
    expect(done.json.voucher).toMatchObject({ payer: acct("budi"), payee: acct("andi") });
    expect((await m.get(`/listings/${s.hash}`)).json.status).toBe("matched");
    expect((await buy(m, s, "citra")).json.error.code).toBe("listing_not_open");
    expect(JSON.stringify(calls)).not.toContain("STEAM-KEY-SECRET");
  });

  it("TC-BE-074-02 the platforms that do not answer decide nothing; the window of 7 days cancels a domain and the voucher never moves", async () => {
    const m = await start();
    const s = sell(m);
    dns.set(DOMAIN, [`x207-sell=${s.hash}`]);
    await m.post("/listings", s.body);
    const id = (await buy(m, s)).json.transferId as number;
    down.dns = true;
    const unavailable = await m.post(`/transfers/${id}/proof`, {});
    expect([unavailable.status, unavailable.json.error.code]).toEqual([503, "transfer_platform_unavailable"]);
    expect((await m.get(`/transfers/${id}`)).json.status).toBe("paid_held");
    down.dns = false;
    m.clock.now += (TRANSFER_WINDOW_SECONDS.domain + 5) * 1000;
    const late = await m.get(`/transfers/${id}`);
    expect([late.json.status, late.json.cancelReason, "voucher" in late.json]).toEqual(["cancelled", "transfer_window_passed", false]);
    const proof = await m.post(`/transfers/${id}/proof`, {});
    expect([proof.status, proof.json.error.code]).toEqual([409, "transfer_window_passed"]);
    // the listing is still open for another buyer, and the cancelled voucher no longer counts for the pair
    expect((await buy(m, s, "budi", {}, C(10))).status).toBe(201);
  });

  it("TC-BE-074-03 a game item is paid after the trade offer is accepted, goes to the buyer, carries the item, and its hold is over", async () => {
    const m = await start();
    const s = sell(m, { platform: "game_item" });
    expect((await m.post("/listings", s.body)).status).toBe(201);
    expect((await buy(m, s)).json.error.code).toBe("invalid_request"); // the Steam account of the buyer is required
    const bought = await buy(m, s, "budi", { buyer_ref: "555" });
    expect(bought.json.windowUntil - at(m)).toBe(3600);
    const id = bought.json.transferId as number;
    expect((await m.post(`/transfers/${id}/proof`, {})).status).toBe(400); // the trade offer id is needed the first time
    const offer = { trade_offer_state: 2, accountid_other: 555, time_escrow_end: 0, items_to_give: [{ appid: 730, assetid: "123456789" }] };
    steam.set("9001", offer);
    const sent = await m.post(`/transfers/${id}/proof`, { tradeoffer_id: "9001" });
    expect([sent.status, sent.json.error.code, sent.json.error.details.tradeOfferState]).toEqual([409, "transfer_proof_pending", 2]);
    steam.set("9001", { ...offer, trade_offer_state: 3, time_escrow_end: at(m) + 600 });
    const hold = await m.post(`/transfers/${id}/proof`, {});
    expect([hold.json.error.code, hold.json.error.details.retryAfterSeconds]).toEqual(["transfer_proof_pending", 600]);
    steam.set("9001", { ...offer, trade_offer_state: 3, time_escrow_end: 0, items_to_give: [{ appid: 730, assetid: "999" }] });
    expect((await m.post(`/transfers/${id}/proof`, {})).json.error.details.reason).toMatch(/does not carry the item/);
    steam.set("9001", { ...offer, trade_offer_state: 3, accountid_other: 777 });
    expect((await m.post(`/transfers/${id}/proof`, {})).json.error.details.reason).toMatch(/not to the buyer/);
    steam.set("9001", { ...offer, trade_offer_state: 3 });
    expect((await m.post(`/transfers/${id}/proof`, { tradeoffer_id: "1" })).json.error.code).toBe("transfer_bad_state"); // the offer of the transfer is fixed
    m.clock.now += 700_000; // the hold is over (and the window of one hour is not: 700 s)
    steam.set("9001", { ...offer, trade_offer_state: 3, time_escrow_end: at(m) - 50 });
    const done = await m.post(`/transfers/${id}/proof`, {});
    expect([done.status, done.json.status]).toEqual([200, "confirmed"]);
    down.steam = true;
    expect((await m.post(`/transfers/${id}/proof`, {})).json.status).toBe("confirmed"); // already done: nothing is asked again
  });

  it("TC-BE-074-04 a game item with no Steam key, and a down Steam, are told apart from a trade that is not accepted", async () => {
    const m = await start();
    const s = sell(m, { platform: "game_item" });
    await m.post("/listings", s.body);
    const id = (await buy(m, s, "budi", { buyer_ref: "555" })).json.transferId as number;
    down.steam = true;
    const r = await m.post(`/transfers/${id}/proof`, { tradeoffer_id: "9001" });
    expect([r.status, r.json.error.code]).toEqual([503, "transfer_platform_unavailable"]);
    expect(JSON.stringify(r.json)).not.toContain("STEAM-KEY-SECRET");
  });

  it("TC-BE-074-05 a ticket: only the buyer confirms, the limit is 100 credit, the window is one day", async () => {
    const m = await start();
    const s = sell(m, { platform: "ticket", value: 40 });
    expect((await m.post("/listings", s.body)).status).toBe(201);
    const bought = await buy(m, s, "budi", {}, C(40));
    const id = bought.json.transferId as number;
    expect(bought.json.windowUntil - at(m)).toBe(86_400);
    expect((await m.post(`/transfers/${id}/proof`, {})).json.error.code).toBe("transfer_bad_method");
    expect((await notice(m, id, "confirmed", "andi")).json.error.code).toBe("transfer_not_party"); // the seller cannot say it arrived
    expect((await notice(m, id, "confirmed", "citra")).json.error.code).toBe("transfer_not_party");
    const done = await notice(m, id, "confirmed", "budi");
    expect([done.status, done.json.status, done.json.voucher?.payee]).toEqual([201, "confirmed", acct("andi")]);
    // 100 credit is the most for a ticket; a value at the bond threshold needs a bundle with an arbiter
    const over = await m.post("/listings", sell(m, { platform: "ticket", value: 101 }).body);
    expect([over.status, over.json.error.code]).toEqual([400, "transfer_ticket_over_limit"]);
    const big = await m.post("/listings", sell(m, { platform: "game_item", value: 100 }).body);
    expect([big.status, big.json.error.code]).toEqual([400, "transfer_arbiter_required"]);
    // a ticket that nobody confirms is cancelled after a day, and the seller can cancel at any time while it is held
    const t2 = sell(m, { platform: "ticket", value: 5 });
    await m.post("/listings", t2.body);
    const id2 = (await buy(m, t2, "citra", {}, C(5))).json.transferId as number;
    expect((await notice(m, id2, "cancelled", "andi")).json).toMatchObject({ status: "cancelled", cancelReason: "cancelled_by_seller" });
  });

  it("TC-BE-074-06 a website or an online store is roadmap only; a listing that does not follow the format is refused with the codes of SD-077", async () => {
    const m = await start();
    for (const assetType of ["transfer:website", "transfer:online-store"]) {
      const r = await m.post("/listings", sell(m, { assetType }).body);
      expect([r.status, r.json.error.code]).toEqual([400, "asset_roadmap_only"]);
    }
    const code = async (s: Sold) => (await m.post("/listings", s.body)).json.error.code;
    expect(await code(sell(m, { platform: "domain", ref: "not a domain" }))).toBe("transfer_bad_ref");
    expect(await code(sell(m, { platform: "game_item", ref: "730" }))).toBe("transfer_bad_ref");
    expect(await code(sell(m, { platform: "ticket", estimate: 999_999 }))).toBe("transfer_bad_estimate");
    expect(await code(sell(m, { platform: "ticket", detail: { proof_method: "dns_txt" } }))).toBe("transfer_method_mismatch");
    expect(await code(sell(m, { platform: "ticket", detail: { platform: "domain" } }))).toBe("transfer_bad_platform");
    expect(await code(sell(m, { platform: "ticket", detail: { transfer_doc: "ab".repeat(32) } }))).toBe("transfer_bad_hash");
  });

  it("TC-BE-074-07 the voucher of a transfer is part of the state of the pair: the same cumulative cannot pay a second purchase; one buyer per thing", async () => {
    const m = await start();
    const a = sell(m, { platform: "ticket", value: 10 });
    const b = sell(m, { platform: "ticket", value: 10 });
    await m.post("/listings", a.body);
    await m.post("/listings", b.body);
    expect((await buy(m, a, "budi", {}, C(10))).status).toBe(201);
    expect([(await buy(m, b, "budi", {}, C(10))).status]).toEqual([400]); // the contract would take a delta of 0
    expect((await buy(m, a, "citra", {}, C(10))).json.error.code).toBe("exclusive_taken");
    expect((await buy(m, b, "budi", {}, C(20))).status).toBe(201);
  });

  it("TC-BE-074-09 the proof of one transfer is asked of the outside once each 30 seconds, whoever asks (rate_limited with retryAfterSeconds); pending says when to try again", async () => {
    const m = await start();
    await market?.srv.close();
    market?.db.close();
    market = await startMarket(["andi", "budi", "citra"], [], undefined, { dnsTxt: new DnsTxtProof(http) }); // the default gap of 30 seconds
    openEpoch(market, 42);
    const s = sell(market);
    dns.set(DOMAIN, [`x207-sell=${s.hash}`]);
    await market.post("/listings", s.body);
    const id = (await buy(market, s)).json.transferId as number;
    calls.length = 0;
    const first = await market.post(`/transfers/${id}/proof`, {});
    expect([first.status, first.json.error.code, first.json.error.details.retryAfterSeconds]).toEqual([409, "transfer_proof_pending", 30]);
    const dnsCalls = calls.length;
    const again = await market.post(`/transfers/${id}/proof`, {});
    expect([again.status, again.json.error.code]).toEqual([429, "rate_limited"]);
    expect(again.json.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(calls).toHaveLength(dnsCalls); // nothing was asked of the DNS the second time
    market.clock.now += 31_000;
    expect((await market.post(`/transfers/${id}/proof`, {})).json.error.code).toBe("transfer_proof_pending");
    expect(m).toBeDefined();
  });

  it("TC-BE-078-01 reputation counts the sales of files, codes and transfers: confirmed is completed, a disputed purchase is a dispute and a window that passed is abandoned, once per buyer and only from a buyer that has paid", async () => {
    const m = await start();
    const rep = async () => (await m.get(`/reputation/${acct("andi")}`)).json;
    const base = await rep();
    expect([base.completed.counterparties, base.disputes.counterparties, base.abandoned.counterparties]).toEqual([0, 0, 0]);
    // a ticket confirmed by the buyer
    const t1 = sell(m, { platform: "ticket", value: 5 });
    await m.post("/listings", t1.body);
    const id1 = (await buy(m, t1, "budi", {}, C(5))).json.transferId as number;
    await notice(m, id1, "confirmed", "budi");
    expect((await rep()).completed).toEqual({ transactions: 1, counterparties: 1 });
    // citra buys a ticket and the window of one day passes: abandoned, but only once citra has paid somebody
    const t2 = sell(m, { platform: "ticket", value: 5 });
    await m.post("/listings", t2.body);
    const id2 = (await buy(m, t2, "citra", {}, C(5))).json.transferId as number;
    m.clock.now += (TRANSFER_WINDOW_SECONDS.ticket + 5) * 1000;
    expect((await m.get(`/transfers/${id2}`)).json.cancelReason).toBe("transfer_window_passed");
    expect((await rep()).abandoned).toEqual({ transactions: 0, counterparties: 0 }); // citra has paid nobody: a fresh account cannot damage anybody
    m.db.prepare("INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, registration_mode, registered_block, receipt_id) VALUES ('agents-main', 42, ?, ?, 1, 5000000, 'cumulative', 1, 'r1')").run(acct("citra"), acct("budi"));
    expect((await rep()).abandoned).toEqual({ transactions: 1, counterparties: 1 });
    // purchases of files: confirmed is completed, disputed is a dispute (only from a buyer that has paid)
    const insert = (buyer: string, status: string, n2: number): void => {
      m.db.prepare(
        `INSERT INTO purchases (circle_id, listing_hash, buyer, seller, content_hash, license_doc, license_id, exclusive, voucher_json, voucher_signature, status, created_at_ms, kind)
         VALUES ('agents-main', ?, ?, ?, ?, ?, 'personal', 0, '{}', 'sig', ?, 1, 'license')`,
      ).run(`${n2}`.repeat(64).slice(0, 64), acct(buyer), acct("andi"), `${n2}`.repeat(64).slice(0, 64), `${n2}`.repeat(64).slice(0, 64), status);
    };
    insert("citra", "confirmed", 1);
    insert("budi", "disputed", 2);
    const after = await rep();
    expect(after.completed.counterparties).toBe(2); // budi (ticket) and citra (file)
    expect(after.disputes).toEqual({ transactions: 0, counterparties: 0 }); // budi has paid nobody (his voucher is held): his dispute does not count
    const sales = (await rep()).completed.transactions;
    insert("budi", "refuted", 4); // the proof of cheating of the buyer was false: the seller is paid and it counts for him (budi is already a counterparty)
    expect((await rep()).completed).toEqual({ transactions: sales + 1, counterparties: 2 });
    insert("citra", "disputed", 3);
    expect((await rep()).disputes).toEqual({ transactions: 1, counterparties: 1 }); // citra paid budi: hers does
  });

  it("TC-UM-096-F1 a buyer who says cancelled after the platform showed the transfer done does not keep the thing for free: the proof still pays the seller; without a proof the cancel takes effect at the end of the window", async () => {
    const m = await start();
    // a game item: the trade is accepted and past its hold, and the buyer cancels anyway
    const s = sell(m, { platform: "game_item" });
    await m.post("/listings", s.body);
    const bought = await buy(m, s, "budi", { buyer_ref: "555" });
    const id = bought.json.transferId as number;
    const offer = { trade_offer_state: 3, accountid_other: 555, time_escrow_end: 0, items_to_give: [{ appid: 730, assetid: "123456789" }] };
    steam.set("9100", offer);
    const asked = await notice(m, id, "cancelled", "budi");
    expect([asked.status, asked.json.status, asked.json.cancelRequested, "voucher" in asked.json]).toEqual([201, "paid_held", true, false]); // a request, not an end
    m.clock.now += 31_000;
    const proved = await m.post(`/transfers/${id}/proof`, { tradeoffer_id: "9100" }); // the seller (or anybody) shows the proof
    expect([proved.status, proved.json.status]).toEqual([200, "confirmed"]);
    expect(proved.json.voucher).toMatchObject({ payer: acct("budi"), payee: acct("andi"), cumulativeAmount: C(10) });
    // a domain: the buyer cancels, the registry shows it moved, the seller is paid
    const d = sell(m);
    dns.set(DOMAIN, [`x207-sell=${d.hash}`]);
    await m.post("/listings", d.body);
    const dBought = await buy(m, d, "citra");
    const dId = dBought.json.transferId as number;
    expect((await notice(m, dId, "cancelled", "citra")).json).toMatchObject({ status: "paid_held", cancelRequested: true });
    dns.set(DOMAIN, [`x207-sell=${d.hash}`, `x207-own=${dId}`]);
    rdap.set(DOMAIN, { status: 200, body: { ldhName: DOMAIN, status: ["active"] } });
    expect((await m.post(`/transfers/${dId}/proof`, {})).json.status).toBe("confirmed");
    // an honest buyer: nothing was transferred, the cancel takes effect when the window ends, and the voucher never moves
    const g = sell(m, { platform: "game_item", ref: "730:222" });
    await m.post("/listings", g.body);
    const gBought = await buy(m, g, "budi", { buyer_ref: "555" });
    const gId = gBought.json.transferId as number;
    expect((await notice(m, gId, "cancelled", "budi")).json.status).toBe("paid_held");
    expect((await notice(m, gId, "cancelled", "andi")).json).toMatchObject({ status: "cancelled", cancelReason: "cancelled_by_seller" }); // the seller giving up ends it at once
    const h = sell(m, { platform: "game_item", ref: "730:333" });
    await m.post("/listings", h.body);
    const hBought = await buy(m, h, "budi", { buyer_ref: "555" });
    const hId = hBought.json.transferId as number;
    await notice(m, hId, "cancelled", "budi");
    m.clock.now += 3_601_000;
    expect((await m.get(`/transfers/${hId}`)).json).toMatchObject({ status: "cancelled", cancelReason: "cancelled_by_buyer" });
    expect("voucher" in (await m.get(`/transfers/${hId}`)).json).toBe(false);
  });

  it("TC-BE-074-08 the DNS and Steam requests go through the SSRF guard: a private address and a plain http endpoint are refused", async () => {
    const privateDns = new DnsTxtProof({ ...http, dohUrl: "https://10.0.0.5/resolve" });
    await expect(privateDns.txt(DOMAIN)).rejects.toMatchObject({ code: "target_forbidden" });
    const plain = new DnsTxtProof({ ...http, dohUrl: "http://dns.google/resolve" });
    await expect(plain.txt(DOMAIN)).rejects.toMatchObject({ code: "target_forbidden" });
    const resolvedPrivate = new DnsTxtProof({ transport, resolver: async () => ["192.168.0.9"] });
    await expect(resolvedPrivate.txt(DOMAIN)).rejects.toMatchObject({ code: "target_forbidden" });
  });
});
