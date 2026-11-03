import { afterEach, describe, expect, it } from "vitest";
import { acceptOffer, bundleFullySigned, listingHash, signBundle, termsHash, type BundleTerms } from "@x207/core";
import { acct, bid, openEpoch, signedListing, startMarket, type Market } from "./helpers.js";

// Angka contoh note F9: nilai 100, diskon 10 (1000 bps), jatah pencari 3 (300 bps); 1 credit = 1_000_000.
const C = (n: number) => String(n * 1_000_000);

describe("BE-041 terima penawaran menjadi usulan bundle", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function negotiate(mode: "pay" | "barter") {
    market = await startMarket(["andi", "budi", "citra", "dewi"]);
    const m = market;
    openEpoch(m, 42);
    const body = signedListing(m, "andi", { offer: { asset_type: "gpu-hours", asset_class: "A", quantity: 10, value: C(100) }, want: { asset_type: "translation", asset_class: "B", quantity: 5, value: C(100) } });
    const hash = listingHash(body.listing);
    await m.post("/listings", body);
    const first = bid(m, "budi", body.listing, { mode, value: C(100) });
    const posted = await m.post(`/listings/${hash}/offers`, first);
    return { m, l: body.listing, hash, offerHash: posted.json.offerHash as string, first };
  }

  it("barter dengan pencari: terms_hash dihitung ulang, Andi menanggung 10, dan semua peserta menandatangani sampai ready", async () => {
    const { m, l, hash, offerHash, first } = await negotiate("barter");
    const mine = acceptOffer({ listing: l, offer: first.offer, epoch: 42, searcher: acct("citra"), searcherShareBps: 300, account: acct("andi") }, m.keys.andi!.secretKey);
    if (mine.kind !== "bundle") throw new Error("harus bundle");

    const res = await m.post(`/listings/${hash}/offers/${offerHash}/accept`, {
      account: acct("andi"), signature: mine.signature.signature, searcher: acct("citra"), searcherShareBps: 300,
    });
    expect(res.status).toBe(201);
    const proposal = res.json.result.proposal;
    expect(res.json.result.kind).toBe("bundle");
    expect(proposal.termsHash).toBe(mine.terms_hash);
    expect(proposal.terms).toEqual(mine.terms);
    // CT-082: the leg that pays the seeker is named in the signed terms
    expect(proposal.terms.search_leg).toEqual({ payer: acct("andi"), payee: acct("citra") });
    expect(proposal.epoch).toBe(42);
    expect(proposal.status).toBe("proposed");
    expect(proposal.missing.sort()).toEqual([acct("budi"), acct("citra")]);
    // 100 + cashback 7 = 107 dari Andi ke Budi, 100 dari Budi ke Andi, 3 dari Andi ke pencari
    const amounts = Object.fromEntries(mine.terms.legs.map((g) => [`${g.payer.split(".")[0]}>${g.payee.split(".")[0]}`, g.max_amount]));
    expect(amounts).toEqual({ "andi>budi": C(107), "budi>andi": C(100), "andi>citra": C(3) });
    expect(res.json.match).toMatchObject({ kind: "bundle", mode: "barter", discountValue: C(10), searcherValue: C(3), searcher: acct("citra"), epoch: 42 });
    expect(res.json.offer.status).toBe("accepted");
    expect((await m.get(`/listings/${hash}`)).json.status).toBe("matched");
    expect((await m.get("/listings")).json.items).toHaveLength(0);

    // Budi dan pencari menandatangani terms_hash yang sama; tanda tangan pertama belum cukup
    const byBudi = signBundle(mine.terms, acct("budi"), m.keys.budi!.secretKey);
    const s1 = await m.post(`/bundle-proposals/${mine.terms_hash}/signatures`, { account: acct("budi"), signature: byBudi.signature });
    expect([s1.status, s1.json.status]).toEqual([201, "proposed"]);
    expect((await m.post(`/bundle-proposals/${mine.terms_hash}/signatures`, { account: acct("budi"), signature: byBudi.signature })).json.error.code).toBe("already_exists");
    const byCitra = signBundle(mine.terms, acct("citra"), m.keys.citra!.secretKey);
    const s2 = await m.post(`/bundle-proposals/${mine.terms_hash}/signatures`, { account: acct("citra"), signature: byCitra.signature });
    expect([s2.status, s2.json.status, s2.json.missing]).toEqual([201, "ready", []]);

    const keys = Object.fromEntries(["andi", "budi", "citra"].map((n) => [acct(n), m.keys[n]!.publicKey]));
    expect(bundleFullySigned(s2.json.terms as BundleTerms, s2.json.signatures, keys)).toBe(true);
    expect((await m.get("/bundle-proposals?status=ready")).json.items).toHaveLength(1);
    expect((await m.get(`/bundle-proposals?account=${acct("dewi")}`)).json.items).toHaveLength(0);
    expect((await m.get(`/bundle-proposals/${mine.terms_hash}`)).json.listingHash).toBe(hash);
  });

  it("bayar tanpa pencari: satu pembayaran voucher 90, bukan bundle, listing matched", async () => {
    const { m, hash, offerHash } = await negotiate("pay");
    const res = await m.post(`/listings/${hash}/offers/${offerHash}/accept`, { account: acct("andi") });
    expect(res.status).toBe(201);
    expect(res.json.result).toEqual({ kind: "payment", payer: acct("budi"), payee: acct("andi"), amount: C(90) });
    expect(res.json.match).toMatchObject({ kind: "payment", termsHash: null, discountValue: C(10), searcherValue: "0", searcher: null });
    expect((await m.get(`/listings/${hash}`)).json.status).toBe("matched");
    expect((await m.get("/bundle-proposals")).json.items).toHaveLength(0);
  });

  it("bayar dengan pencari: lawan membayar 93, 90 ke Andi dan 3 ke pencari", async () => {
    const { m, l, hash, offerHash, first } = await negotiate("pay");
    const mine = acceptOffer({ listing: l, offer: first.offer, epoch: 42, searcher: acct("citra"), searcherShareBps: 300, account: acct("andi") }, m.keys.andi!.secretKey);
    if (mine.kind !== "bundle") throw new Error("harus bundle");
    const res = await m.post(`/listings/${hash}/offers/${offerHash}/accept`, { account: acct("andi"), signature: mine.signature.signature, searcher: acct("citra"), searcherShareBps: 300 });
    expect(res.status).toBe(201);
    expect(mine.terms.legs.map((g) => g.max_amount).sort()).toEqual([C(3), C(90)].sort());
    expect(res.json.match).toMatchObject({ discountValue: C(10), searcherValue: C(3) });
    expect(res.json.result.proposal.missing).toEqual([acct("budi"), acct("citra")].sort());
  });

  it("penolakan: bukan pihak yang ditunggu, tanda tangan terms_hash salah, epoch tidak open, pencari di luar anggota", async () => {
    const { m, l, hash, offerHash, first } = await negotiate("barter");
    const path = `/listings/${hash}/offers/${offerHash}/accept`;
    const mineNoSearcher = acceptOffer({ listing: l, offer: first.offer, epoch: 42, account: acct("andi") }, m.keys.andi!.secretKey);
    if (mineNoSearcher.kind !== "bundle") throw new Error("harus bundle");
    expect((await m.post(path, { account: acct("budi"), signature: "x" })).status).toBe(400);
    expect((await m.post(path, { account: acct("andi") })).status).toBe(400);
    // tanda tangan untuk terms tanpa pencari tidak cocok dengan terms yang dihitung dengan pencari
    const bad = await m.post(path, { account: acct("andi"), signature: mineNoSearcher.signature.signature, searcher: acct("citra"), searcherShareBps: 300 });
    expect([bad.status, bad.json.error.code]).toEqual([401, "invalid_signature"]);
    expect((await m.post(path, { account: acct("andi"), signature: mineNoSearcher.signature.signature, epoch: 41 })).json.error.code).toBe("epoch_not_open");
    expect((await m.post(path, { account: acct("andi"), signature: mineNoSearcher.signature.signature, searcher: acct("zed") })).json.error.code).toBe("member_not_found");
    expect((await m.post(path, { account: acct("andi"), signature: mineNoSearcher.signature.signature, searcher: acct("budi") })).status).toBe(400);
    // jatah pencari di atas diskon ditolak SDK
    expect((await m.post(path, { account: acct("andi"), signature: mineNoSearcher.signature.signature, searcher: acct("citra"), searcherShareBps: 2000 })).status).toBe(400);
    // tidak ada epoch open
    m.db.prepare("UPDATE epochs SET phase = 'clearing'").run();
    expect((await m.post(path, { account: acct("andi"), signature: mineNoSearcher.signature.signature })).json.error.code).toBe("epoch_not_open");
    m.db.prepare("UPDATE epochs SET phase = 'open'").run();
    // setelah diterima, penerimaan ulang dan tawaran baru ditolak
    expect((await m.post(path, { account: acct("andi"), signature: mineNoSearcher.signature.signature })).status).toBe(201);
    expect((await m.post(path, { account: acct("andi"), signature: mineNoSearcher.signature.signature })).json.error.code).toBe("listing_not_open");
    expect((await m.post(`/bundle-proposals/${"0".repeat(64)}/signatures`, { account: acct("budi"), signature: "x" })).json.error.code).toBe("proposal_not_found");
  });

  it("tanda tangan tambahan ditolak setelah epoch bundle tidak open lagi, dan dari akun di luar bundle", async () => {
    const { m, l, hash, offerHash, first } = await negotiate("barter");
    const mine = acceptOffer({ listing: l, offer: first.offer, epoch: 42, account: acct("andi") }, m.keys.andi!.secretKey);
    if (mine.kind !== "bundle") throw new Error("harus bundle");
    await m.post(`/listings/${hash}/offers/${offerHash}/accept`, { account: acct("andi"), signature: mine.signature.signature });
    const byBudi = signBundle(mine.terms, acct("budi"), m.keys.budi!.secretKey);
    const outsider = signBundle(mine.terms, acct("dewi"), m.keys.dewi!.secretKey);
    expect((await m.post(`/bundle-proposals/${mine.terms_hash}/signatures`, { account: acct("dewi"), signature: outsider.signature })).status).toBe(400);
    expect((await m.post(`/bundle-proposals/${mine.terms_hash}/signatures`, { account: acct("budi"), signature: outsider.signature })).json.error.code).toBe("invalid_signature");
    m.db.prepare("UPDATE epochs SET phase = 'clearing'").run();
    expect((await m.post(`/bundle-proposals/${mine.terms_hash}/signatures`, { account: acct("budi"), signature: byBudi.signature })).json.error.code).toBe("epoch_not_open");
  });
});

describe("BE-041 pratinjau penerimaan", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  it("preview memuat angka akhir dan pesan yang ditandatangani tanpa menyimpan apa pun", async () => {
    market = await startMarket(["andi", "budi", "citra"]);
    const m = market;
    openEpoch(m, 42);
    const body = signedListing(m, "andi", { offer: { asset_type: "gpu-hours", asset_class: "A", quantity: 10, value: C(100) }, want: { asset_type: "translation", asset_class: "B", quantity: 5, value: C(100) } });
    const hash = listingHash(body.listing);
    await m.post("/listings", body);
    const first = bid(m, "budi", body.listing, { value: C(100) });
    const offerHash = (await m.post(`/listings/${hash}/offers`, first)).json.offerHash;

    const res = await m.post(`/listings/${hash}/offers/${offerHash}/preview`, { account: acct("andi"), searcher: acct("citra"), searcherShareBps: 300 });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ kind: "bundle", epoch: 42, mode: "barter", discountValue: C(10), searcherValue: C(3), searcher: acct("citra") });
    expect(res.json.breakdown).toMatchObject({ mode: "barter", cashback: C(7), searcher: C(3), sellerBears: C(10), counterpartyGives: C(100) });
    const mine = acceptOffer({ listing: body.listing, offer: first.offer, epoch: 42, searcher: acct("citra"), searcherShareBps: 300, account: acct("andi") }, m.keys.andi!.secretKey);
    if (mine.kind !== "bundle") throw new Error("harus bundle");
    expect(res.json.bundle).toMatchObject({ termsHash: mine.terms_hash, recipient: "x207-circle.near", participants: [acct("andi"), acct("budi"), acct("citra")].sort() });
    expect(JSON.parse(res.json.bundle.message)).toMatchObject({ circle: "x207-circle.near", epoch: 42 });
    expect(Buffer.from(res.json.bundle.nonce, "base64").toString("hex")).toBe(mine.terms_hash);

    // tidak ada yang tersimpan
    expect((await m.get(`/listings/${hash}`)).json.status).toBe("open");
    expect((await m.get("/bundle-proposals")).json.items).toHaveLength(0);
    expect((await m.post(`/listings/${hash}/offers/${offerHash}/preview`, { account: acct("budi") })).status).toBe(400);
  });

  it("preview jalur bayar tanpa pencari menampilkan satu pembayaran", async () => {
    const { m, hash, offerHash } = await (async () => {
      market = await startMarket(["andi", "budi"]);
      const mm = market;
      openEpoch(mm, 42);
      const body = signedListing(mm, "andi", { offer: { asset_type: "gpu-hours", asset_class: "A", quantity: 10, value: C(100) } });
      await mm.post("/listings", body);
      const h = listingHash(body.listing);
      const o = (await mm.post(`/listings/${h}/offers`, bid(mm, "budi", body.listing, { mode: "pay", value: C(100) }))).json.offerHash;
      return { m: mm, hash: h, offerHash: o };
    })();
    const res = await m.post(`/listings/${hash}/offers/${offerHash}/preview`, { account: acct("andi") });
    expect(res.json).toMatchObject({ kind: "payment", bundle: null, payment: { payer: acct("budi"), payee: acct("andi"), amount: C(90) } });
    expect(res.json.breakdown).toMatchObject({ mode: "pay", counterpartyPays: C(90), sellerReceives: C(90), searcher: "0", discount: C(10) });
  });
});

describe("BE-041 lawan menerima penawaran balik pemasang", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  it("leg tetap antara pemasang dan lawan, sama dengan bila pemasang menerima penawaran lawan", async () => {
    market = await startMarket(["andi", "budi"]);
    const m = market;
    openEpoch(m, 42);
    const body = signedListing(m, "andi", { offer: { asset_type: "gpu-hours", asset_class: "A", quantity: 10, value: C(100) }, want: { asset_type: "translation", asset_class: "B", quantity: 5, value: C(100) } });
    const hash = listingHash(body.listing);
    await m.post("/listings", body);
    const first = bid(m, "budi", body.listing, { value: C(85) });
    const o1 = (await m.post(`/listings/${hash}/offers`, first)).json.offerHash;
    const second = bid(m, "andi", body.listing, { value: C(95), previous: first.offer });
    const o2 = (await m.post(`/listings/${hash}/offers`, { ...second, inReplyTo: o1 })).json.offerHash;

    const preview = await m.post(`/listings/${hash}/offers/${o2}/preview`, { account: acct("budi") });
    expect(preview.status).toBe(200);
    // nilai kesepakatan 95 (penawaran balik), bukan 100 di listing atau 85 di tawaran pertama
    const expected = acceptOffer({ listing: body.listing, offer: second.offer, counterparty: acct("budi"), epoch: 42, account: acct("andi") }, m.keys.andi!.secretKey);
    if (expected.kind !== "bundle") throw new Error("harus bundle");
    expect(preview.json.bundle.termsHash).toBe(expected.terms_hash);
    expect(expected.terms.legs.map((l) => l.max_amount).sort()).toEqual([C(95), String(109_500_000)].sort());
    expect(preview.json.breakdown).toMatchObject({ mode: "barter", sellerBears: String(9_500_000) });

    const mine = signBundle(expected.terms, acct("budi"), m.keys.budi!.secretKey);
    const res = await m.post(`/listings/${hash}/offers/${o2}/accept`, { account: acct("budi"), signature: mine.signature });
    expect(res.status).toBe(201);
    expect(res.json.result.proposal.missing).toEqual([acct("andi")]);
    expect(res.json.match).toMatchObject({ seller: acct("andi"), counterparty: acct("budi") });
  });
});

describe("BE-041 epoch open dari kontrak, bukan hanya dari D9", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  async function negotiated(chainView?: Parameters<typeof startMarket>[2]) {
    market = await startMarket(["andi", "budi"], [], chainView);
    const m = market;
    const body = signedListing(m, "andi", { offer: { asset_type: "gpu-hours", asset_class: "A", quantity: 10, value: C(100) } });
    const hash = listingHash(body.listing);
    await m.post("/listings", body);
    const first = bid(m, "budi", body.listing, { mode: "pay", value: C(100) });
    const offerHash = (await m.post(`/listings/${hash}/offers`, first)).json.offerHash;
    return { m, hash, offerHash };
  }

  it("epoch pertama tanpa baris D9: penerimaan jalan lewat view get_epoch", async () => {
    const calls: string[] = [];
    const { m, hash, offerHash } = await negotiated(async (contract, method) => (calls.push(`${contract}:${method}`), { epoch: 1, phase: "open" }));
    expect(m.db.prepare("SELECT COUNT(*) AS n FROM epochs").get()).toEqual({ n: 0 });
    const res = await m.post(`/listings/${hash}/offers/${offerHash}/accept`, { account: acct("andi") });
    expect(res.status).toBe(201);
    expect(res.json.result).toMatchObject({ kind: "payment" });
    expect(calls).toEqual(["x207-circle.near:get_epoch"]);
  });

  it("view menjawab epoch bukan open: ditolak epoch_not_open walau D9 masih menyebut open", async () => {
    const { m, hash, offerHash } = await negotiated(async () => ({ epoch: 1, phase: "clearing" }));
    openEpoch(m, 1);
    const res = await m.post(`/listings/${hash}/offers/${offerHash}/accept`, { account: acct("andi") });
    expect([res.status, res.json.error.code]).toEqual([409, "epoch_not_open"]);
  });

  it("view gagal: jatuh ke D9; tanpa D9 juga ditolak epoch_not_open", async () => {
    const { m, hash, offerHash } = await negotiated(async () => {
      throw new Error("rpc down");
    });
    expect((await m.post(`/listings/${hash}/offers/${offerHash}/accept`, { account: acct("andi") })).json.error.code).toBe("epoch_not_open");
    openEpoch(m, 1);
    expect((await m.post(`/listings/${hash}/offers/${offerHash}/accept`, { account: acct("andi") })).status).toBe(201);
  });
});

describe("BE-041 usulan bundle dari solver tanpa kecocokan (SV-011)", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  const ring = (epoch = 42) => ({
    circle: "x207-circle.near", epoch,
    legs: [
      { payer: acct("andi"), payee: acct("budi"), max_amount: C(6) },
      { payer: acct("budi"), payee: acct("citra"), max_amount: C(10) },
      { payer: acct("citra"), payee: acct("andi"), max_amount: C(8) },
    ],
  });

  it("CT-082: usulan yang membawa pencari harus menamai search_leg, tanpa itu ditolak", async () => {
    market = await startMarket(["andi", "budi", "citra"]);
    const m = market;
    openEpoch(m, 42);
    const plain = ring();
    const refused = await m.post("/bundle-proposals", { terms: plain, searcher: acct("citra") });
    expect(refused.status).toBe(400);
    expect(refused.json.error.message).toMatch(/search_leg/);
    const named = { ...plain, search_leg: { payer: acct("budi"), payee: acct("citra") } };
    const ok = await m.post("/bundle-proposals", { terms: named, termsHash: termsHash(named), searcher: acct("citra") });
    expect(ok.status).toBe(201);
    expect(ok.json.terms.search_leg).toEqual({ payer: acct("budi"), payee: acct("citra") });
    expect(ok.json.termsHash).not.toBe(termsHash(plain));
    // a seeker who receives no leg at all is refused too
    const stranger = await m.post("/bundle-proposals", { terms: named, searcher: acct("dewi") });
    expect(stranger.status).toBe(400);
  });

  it("solver mengirim syarat cincin, peserta menandatangani, status ready untuk di-commit", async () => {
    market = await startMarket(["andi", "budi", "citra"]);
    const m = market;
    openEpoch(m, 42);
    const terms = ring();
    const hash = termsHash(terms);
    const created = await m.post("/bundle-proposals", { terms, termsHash: hash });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ termsHash: hash, status: "proposed", epoch: 42, listingHash: null, searcher: null });
    expect(created.json.participants.sort()).toEqual([acct("andi"), acct("budi"), acct("citra")]);
    expect(created.json.missing).toHaveLength(3);
    // idempoten: kiriman kedua mengembalikan usulan yang sama
    const again = await m.post("/bundle-proposals", { terms });
    expect([again.status, again.json.termsHash]).toEqual([200, hash]);
    expect(m.db.prepare("SELECT COUNT(*) AS n FROM bundle_proposals").get()).toEqual({ n: 1 });
    // agent menemukannya lewat akunnya dan menandatangani
    const mine = await m.get(`/bundle-proposals?account=${acct("budi")}&status=proposed`);
    expect(mine.json.items.map((p: any) => p.termsHash)).toEqual([hash]);
    for (const name of ["andi", "budi", "citra"]) {
      const sig = signBundle(terms, acct(name), m.keys[name]!.secretKey);
      expect((await m.post(`/bundle-proposals/${hash}/signatures`, { account: acct(name), signature: sig.signature })).status).toBe(201);
    }
    const ready = await m.get("/bundle-proposals?status=ready");
    expect(ready.json.items.map((p: any) => [p.termsHash, p.status, p.missing])).toEqual([[hash, "ready", []]]);
  });

  it("penolakan: epoch bukan open, lingkaran salah, anggota bukan aktif atau tidak ada, hash klaim salah, format cacat", async () => {
    market = await startMarket(["andi", "budi"], ["citra"]);
    const m = market;
    openEpoch(m, 42);
    expect((await m.post("/bundle-proposals", { terms: ring(41) })).json.error.code).toBe("epoch_not_open");
    expect((await m.post("/bundle-proposals", { terms: { ...ring(), circle: "other.near" } })).status).toBe(400);
    expect((await m.post("/bundle-proposals", { terms: ring() })).json.error.code).toBe("member_not_active"); // citra suspended
    const unknown = { ...ring(), legs: ring().legs.map((l) => ({ ...l, payee: l.payee === acct("citra") ? acct("zed") : l.payee, payer: l.payer === acct("citra") ? acct("zed") : l.payer })) };
    expect((await m.post("/bundle-proposals", { terms: unknown })).json.error.code).toBe("member_not_found");
    expect((await m.post("/bundle-proposals", { terms: ring(), termsHash: "0".repeat(64) })).status).toBe(400);
    expect((await m.post("/bundle-proposals", { terms: { circle: "x207-circle.near", epoch: 42, legs: [] } })).status).toBe(400);
    expect((await m.post("/bundle-proposals", {})).status).toBe(400);
    expect(m.db.prepare("SELECT COUNT(*) AS n FROM bundle_proposals").get()).toEqual({ n: 0 });
  });

  it("migrasi 1104 pada basis data lama mempertahankan usulan dan menandai sumbernya accept", async () => {
    const { default: Database } = await import("better-sqlite3");
    const { migrate } = await import("../../src/db/migrate.js");
    const { MARKETPLACE_MIGRATIONS } = await import("../../src/marketplace/migrations.js");
    const db = new Database(":memory:");
    migrate(db);
    migrate(db, MARKETPLACE_MIGRATIONS.filter((m) => m.version <= 1103));
    db.prepare("INSERT INTO circles (circle_id, contract_id, network) VALUES ('agents-main', 'x207-circle.near', 'x207:agents-main')").run();
    db.prepare("INSERT INTO matches (circle_id, listing_hash, offer_hash, seller, counterparty, mode, kind, epoch, terms_hash, listing_value, discount_value, searcher_value, matched_at_ms) VALUES ('agents-main', 'l', 'o', 'a', 'b', 'barter', 'bundle', 42, 'h', '1', '0', '0', 1)").run();
    db.prepare("INSERT INTO bundle_proposals (circle_id, terms_hash, match_id, epoch, terms_json, created_at_ms) VALUES ('agents-main', 'h', 1, 42, '{}', 1)").run();
    expect(migrate(db, MARKETPLACE_MIGRATIONS)).toEqual([1104, 1105, 1106]);
    expect(db.prepare("SELECT terms_hash, match_id, source, status FROM bundle_proposals").all()).toEqual([{ terms_hash: "h", match_id: 1, source: "accept", status: "proposed" }]);
    db.prepare("INSERT INTO bundle_proposals (circle_id, terms_hash, match_id, epoch, terms_json, source, created_at_ms) VALUES ('agents-main', 'h2', NULL, 42, '{}', 'solver', 2)").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM bundle_proposals").get()).toEqual({ n: 2 });
    db.close();
  });
});
