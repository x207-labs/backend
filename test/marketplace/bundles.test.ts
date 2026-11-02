import { afterEach, describe, expect, it } from "vitest";
import { acceptOffer, bundleFullySigned, listingHash, signBundle, type BundleTerms } from "@x207/core";
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
