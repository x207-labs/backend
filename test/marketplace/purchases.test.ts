import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  contentHash, createRelease, deriveBoxKey, encryptContent, licenseDocumentHash, licenseResource, listingHash, makeCheatProof, signVoucher,
  type LicenseDocument, type LicenseRelease, type UnsignedVoucher,
} from "@x207/core";
import { sha256Hex, signNoticeJson } from "../../src/marketplace/notice.js";
import { MAX_DOWNLOADS, Semaphore } from "../../src/marketplace/purchases.js";
import type { Transport } from "../../src/marketplace/ssrf.js";
import { acct, CONTRACT, openEpoch, signedListing, startMarket, type Market } from "./helpers.js";

const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();
const utf8 = (t: string): Uint8Array => new TextEncoder().encode(t);
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("BE-056 license handover: fair exchange with encryption", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });
  /** What the "internet" serves: https://store.example.com/<path> -> bytes. */
  const files = new Map<string, Uint8Array>();
  const asked: Array<{ timeoutMs: number; maxBytes: number | undefined; sink: boolean }> = [];
  const transport: Transport = async ({ host, path, method, onChunk, timeoutMs, maxBytes }) => {
    if (method !== "HEAD") asked.push({ timeoutMs, maxBytes, sink: onChunk !== undefined });
    const bytes = files.get(`${host}${path}`);
    if (!bytes) return { status: 404, body: Buffer.alloc(0), truncated: false };
    if (method === "HEAD") return { status: 200, body: Buffer.alloc(0), truncated: false };
    // like the real transport: with a sink the body is handed on in pieces and not kept
    if (onChunk) {
      for (let i = 0; i < bytes.length; i += 16_384) onChunk(Buffer.from(bytes.subarray(i, i + 16_384)));
      return { status: 200, body: Buffer.alloc(0), truncated: false };
    }
    return { status: 200, body: Buffer.from(bytes), truncated: false };
  };
  const resolver = async (host: string) => (host.startsWith("internal") ? ["10.0.0.7"] : ["93.184.216.34"]);

  async function start(names = ["andi", "budi", "citra", "dewi"]) {
    files.clear();
    market = await startMarket(names, [], undefined, { sourceFetch: { resolver, transport } });
    openEpoch(market, 42);
    return market;
  }

  /** The seller andi prepares a file, encrypts it and lists the license. */
  async function sell(m: Market, o: { plain?: string; exclusive?: boolean; nonce?: string; licenseId?: string; preview?: string } = {}) {
    const plain = utf8(o.plain ?? "id,name\n1,alpha\n2,beta\n");
    const { ciphertext, key } = encryptContent(plain);
    const doc: LicenseDocument = {
      circle: CONTRACT, seller: acct("andi"), content_hash: contentHash(plain), license_id: o.licenseId ?? "commercial", license_hash: sha256Hex("terms of the license"),
      preview_hash: o.preview === undefined ? null : sha256Hex(o.preview.trim()), exclusive: o.exclusive ?? false, nonce: o.nonce ?? "d1",
    };
    const docHash = licenseDocumentHash(doc);
    const detail = JSON.stringify({
      kind: "license", asset_type: "data:dataset", license_doc: docHash, content_hash: doc.content_hash, license_id: doc.license_id, license_hash: doc.license_hash,
      exclusive: doc.exclusive, ...(o.preview === undefined ? {} : { preview: o.preview, preview_hash: doc.preview_hash }),
    });
    const body = signedListing(m, "andi", { offer: { asset_type: "data:dataset", asset_class: "B", quantity: 1, value: C(50) }, want: { asset_type: "usdc", asset_class: "A", quantity: 1, value: C(50) }, detail, nonce: `lic-${doc.nonce}` });
    const posted = await m.post("/listings", body);
    return { plain, ciphertext, key, doc, docHash, body, hash: listingHash(body.listing), posted };
  }

  let seq = 0;
  /** The voucher of the buyer for the price of the listing, signed by `who`. */
  function buy(m: Market, s: Awaited<ReturnType<typeof sell>>, who = "budi") {
    const v: UnsignedVoucher = { circle: CONTRACT, payer: acct(who), payee: acct("andi"), epoch: 42, seq: ++seq, cumulativeAmount: C(50), unit: "credit", resource: licenseResource(s.docHash) };
    return m.post(`/listings/${s.hash}/purchases`, { voucher: v, signature: signVoucher(v, m.keys[who]!.secretKey).signature });
  }
  const at = (m: Market) => Math.floor(m.clock.now / 1000);

  const postCipher = (m: Market, id: string, s: Awaited<ReturnType<typeof sell>>, over: { ref?: string; kind?: "https" | "ipfs" } = {}) => {
    const ref = over.ref ?? `https://store.example.com/${s.doc.nonce}.bin`;
    files.set(ref.replace("https://", ""), s.ciphertext);
    const notice = { circle: CONTRACT, purchase_id: id, actor: acct("andi"), action: "cipher_posted", at: at(m), source: { kind: over.kind ?? "https", ref }, cipher_hash: contentHash(s.ciphertext) };
    return m.post(`/purchases/${id}`, { notice, signature: signNoticeJson(JSON.stringify(notice), CONTRACT, m.keys.andi!.secretKey) });
  };
  const releaseKey = (m: Market, id: string, s: Awaited<ReturnType<typeof sell>>, buyer = "budi", over: Partial<{ ciphertext: Uint8Array; contentKey: Uint8Array; content_hash: string }> = {}) => {
    const r = createRelease({
      circle: CONTRACT, license_hash: s.docHash, buyer: acct(buyer), buyerPublicKey: m.keys[buyer]!.publicKey, content_hash: over.content_hash ?? s.doc.content_hash,
      ciphertext: over.ciphertext ?? s.ciphertext, contentKey: over.contentKey ?? s.key, at: at(m), sellerSecretKey: m.keys.andi!.secretKey,
    });
    return { ...r, post: () => m.post(`/purchases/${id}`, { notice: r.release, signature: r.signature }) };
  };
  const buyerNotice = (m: Market, id: string, action: "confirmed" | "disputed" | "cancelled", who = "budi", reason: string | null = null, proof: unknown = null, time = at(m)) => {
    const notice = { circle: CONTRACT, purchase_id: id, actor: acct(who), action, at: time, reason, proof };
    return m.post(`/purchases/${id}`, { notice, signature: signNoticeJson(JSON.stringify(notice), CONTRACT, m.keys[who]!.secretKey) });
  };

  it("TC-BE-056-01 a listing needs a license_id from the list; a preview with an email, a NIK or a card number is refused; a clean preview and a hash that does not match are checked", async () => {
    const m = await start();
    const ids = await m.get("/marketplace/license-ids");
    expect(ids.json.items.map((i: any) => i.licenseId)).toContain("commercial");
    expect(ids.json.items.map((i: any) => i.licenseId)).not.toContain("stock-standard");
    expect((await sell(m, { licenseId: "stock-standard", nonce: "a1" })).posted.json.error.code).toBe("license_id_rejected");
    for (const [preview, kind] of [["name,contact\nAli,ali@example.com", "email"], ["nik\n3171014509900001", "nik"], ["card\n4111 1111 1111 1111", "card"], ["call 0812-3456-7890", "phone"]] as const) {
      const r = await sell(m, { preview, nonce: `p-${kind}` });
      expect(r.posted.status, kind).toBe(400);
      expect(r.posted.json.error.code, kind).toBe("preview_contains_pii");
      expect(r.posted.json.error.details.kinds).toContain(kind);
    }
    const clean = await sell(m, { preview: "id,name\n1,alpha\n2,beta", nonce: "ok1" });
    expect(clean.posted.status).toBe(201);
    const wrongHash = signedListing(m, "andi", { offer: { asset_type: "data:dataset", asset_class: "B", quantity: 1, value: C(50) }, detail: JSON.stringify({ kind: "license", license_doc: "a".repeat(64), content_hash: "b".repeat(64), license_id: "personal", exclusive: false, preview: "hello", preview_hash: "c".repeat(64) }), nonce: "wh" });
    expect((await m.post("/listings", wrongHash)).json.error.code).toBe("scope_invalid");
    // a listing that is not a license is not touched
    expect((await m.post("/listings", signedListing(m, "andi", { nonce: "plain" }))).status).toBe(201);
  });

  it("TC-BE-056-02 the voucher of the buyer is held: it appears in no answer until the purchase is confirmed, and the seller cannot confirm", async () => {
    const m = await start();
    const s = await sell(m);
    const bought = await buy(m, s);
    expect(bought.status).toBe(201);
    const id = bought.json.purchase_id as string;
    expect(bought.json).toMatchObject({ status: "paid_held", buyer: acct("budi"), seller: acct("andi"), exclusive: false });
    const seen = (v: any) => JSON.stringify(v).includes("voucher");
    expect(seen(bought.json) && "voucher" in bought.json).toBe(false);
    const posted = await postCipher(m, id, s);
    expect(posted.json).toMatchObject({ status: "cipher_posted", cipherHash: contentHash(s.ciphertext), source: { kind: "https" } });
    expect("voucher" in posted.json).toBe(false);
    const rel = releaseKey(m, id, s);
    const released = await rel.post();
    expect(released.json).toMatchObject({ status: "key_released", release: rel.release, releaseSignature: rel.signature });
    expect(released.json.disputeUntil).toBe(at(m) + 72 * 3600);
    expect("voucher" in released.json).toBe(false);
    expect((await buyerNotice(m, id, "confirmed", "andi")).status).toBe(403); // the seller cannot confirm its own sale
    const confirmed = await buyerNotice(m, id, "confirmed");
    expect(confirmed.json.status).toBe("confirmed");
    expect(confirmed.json.voucher).toMatchObject({ payer: acct("budi"), payee: acct("andi"), resource: licenseResource(s.docHash), cumulativeAmount: C(50) });
    expect((await m.get(`/purchases/${id}`)).json.voucherSignature).toMatch(/^ed25519:/);
  });

  it("TC-BE-056-03 silence for the whole window confirms; a dispute after the window is refused", async () => {
    const m = await start();
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    await releaseKey(m, id, s).post();
    m.clock.now += 73 * 3600 * 1000;
    const view = (await m.get(`/purchases/${id}`)).json;
    expect(view).toMatchObject({ status: "confirmed", autoConfirmed: true });
    expect(view.voucher).toBeDefined();
    expect((await buyerNotice(m, id, "disputed", "budi", "other")).json.error.code).toBe("purchase_bad_state");
  });

  it("TC-BE-056-04 a wrong file is proven by the proof of cheating and checked by the backend: no payment, the voucher stays held", async () => {
    const m = await start();
    // the seller lists the hash of file A but encrypts and serves file B
    const s = await sell(m, { plain: "the real dataset\n1,2,3\n" });
    const other = encryptContent(utf8("something else entirely\n"));
    const id = (await buy(m, s)).json.purchase_id as string;
    const swapped = { ...s, ciphertext: other.ciphertext, key: other.key };
    await postCipher(m, id, swapped);
    const rel = releaseKey(m, id, s, "budi", { ciphertext: other.ciphertext, contentKey: other.key });
    expect((await rel.post()).json.status).toBe("key_released");
    const proof = makeCheatProof({ ciphertext: other.ciphertext, release: rel.release, signature: rel.signature, sellerPublicKey: m.keys.andi!.publicKey, buyerSecretKey: m.keys.budi!.secretKey });
    expect((await buyerNotice(m, id, "disputed", "budi", "content_mismatch")).json.error.code).toBe("proof_invalid"); // no proof
    const apiProof = { release: proof.release, signature: proof.signature, box_key: proof.box_key };
    const disputed = await buyerNotice(m, id, "disputed", "budi", "content_mismatch", apiProof);
    expect(disputed.status).toBe(201);
    expect(disputed.json).toMatchObject({ status: "disputed", disputeReason: "content_mismatch" });
    expect("voucher" in disputed.json).toBe(false);
    m.clock.now += 100 * 3600 * 1000;
    const after = (await m.get(`/purchases/${id}`)).json;
    expect(after.status).toBe("disputed");
    expect("voucher" in after).toBe(false);
  });

  it("TC-BE-056-05 a false dispute fails: a proof for a correct file is refuted and the voucher is released to the seller", async () => {
    const m = await start();
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    const rel = releaseKey(m, id, s);
    await rel.post();
    // the buyer builds a "proof" for a file that is correct: the box key is real, but the content matches
    const proof = { release: rel.release, signature: rel.signature, box_key: toHex(deriveBoxKey(Buffer.from(rel.release.sealed_key, "hex"), m.keys.budi!.secretKey)) };
    const res = await buyerNotice(m, id, "disputed", "budi", "content_mismatch", proof);
    expect(res.json).toMatchObject({ status: "refuted" });
    expect(res.json.voucher).toMatchObject({ payer: acct("budi"), payee: acct("andi") });
  });

  it("TC-BE-056-06 a proof is refused when the source no longer serves the posted ciphertext, or the release is not the one the seller gave", async () => {
    const m = await start();
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    const rel = releaseKey(m, id, s);
    await rel.post();
    const proof = { release: rel.release, signature: rel.signature, box_key: toHex(deriveBoxKey(Buffer.from(rel.release.sealed_key, "hex"), m.keys.budi!.secretKey)) };
    files.set("store.example.com/d1.bin", utf8("replaced after the fact"));
    expect((await buyerNotice(m, id, "disputed", "budi", "content_mismatch", proof)).json.error.code).toBe("proof_invalid");
    const forged: LicenseRelease = { ...rel.release, at: rel.release.at + 1 };
    expect((await buyerNotice(m, id, "disputed", "budi", "content_mismatch", { ...proof, release: forged })).json.error.code).toBe("proof_invalid");
    // other reasons need no proof and are not paid
    const other = await buyerNotice(m, id, "disputed", "budi", "contains_pii");
    expect(other.json).toMatchObject({ status: "disputed", disputeReason: "contains_pii" });
  });

  it("TC-BE-056-07 a second exclusive license for the same content is refused; the first one gone, it is free again; the list shows who holds it", async () => {
    const m = await start();
    const s = await sell(m, { exclusive: true });
    const first = await buy(m, s, "budi");
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ exclusive: true, needsBond: true });
    const second = await buy(m, s, "citra");
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("exclusive_taken");
    // the same content in another, non-exclusive listing is blocked too while the exclusive one lives
    const nonExclusive = await sell(m, { exclusive: false, nonce: "d2" });
    expect((await buy(m, nonExclusive, "citra")).json.error.code).toBe("exclusive_taken");
    expect((await m.get(`/marketplace/exclusive-licenses?content_hash=${s.doc.content_hash}`)).json.items).toEqual([
      expect.objectContaining({ contentHash: s.doc.content_hash, purchaseId: first.json.purchase_id, buyer: acct("budi"), seller: acct("andi") }),
    ]);
    // the seller cancels the first sale: the content is free
    expect((await buyerNotice(m, first.json.purchase_id, "cancelled", "andi")).json.status).toBe("cancelled");
    expect((await buy(m, s, "citra")).status).toBe(201);
    // and an exclusive license cannot be bought while another license of the content is alive
    const m2 = await start();
    const shared = await sell(m2, { exclusive: false, nonce: "s1" });
    expect((await buy(m2, shared, "budi")).status).toBe(201);
    const excl = await sell(m2, { exclusive: true, nonce: "s2" });
    expect((await buy(m2, excl, "citra")).json.error.code).toBe("exclusive_taken");
  });

  it("TC-BE-056-08 a takedown hides the listing and cancels the sales that are not confirmed; a confirmed sale stays", async () => {
    const m = await start();
    const s = await sell(m);
    const confirmedId = (await buy(m, s, "budi")).json.purchase_id as string;
    await postCipher(m, confirmedId, s);
    await releaseKey(m, confirmedId, s, "budi").post();
    await buyerNotice(m, confirmedId, "confirmed");
    const openId = (await buy(m, s, "citra")).json.purchase_id as string;
    const claim = "this dataset is mine";
    const evidence = sha256Hex("proof of ownership");
    const message = JSON.stringify({ circle: CONTRACT, listing_hash: s.hash, claim, evidence_hash: evidence });
    expect((await m.post(`/listings/${s.hash}/takedown`, { claim, evidence_hash: evidence, signature: signNoticeJson(message, CONTRACT, m.keys.andi!.secretKey) })).status).toBe(400); // the seller itself
    expect((await m.post(`/listings/${s.hash}/takedown`, { claim, evidence_hash: evidence, signature: "ed25519:" + "1".repeat(88) })).status).toBe(401);
    const res = await m.post(`/listings/${s.hash}/takedown`, { claim, evidence_hash: evidence, signature: signNoticeJson(message, CONTRACT, m.keys.dewi!.secretKey) });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ claimant: acct("dewi"), hidden: true, cancelledPurchases: 1 });
    expect((await m.get(`/purchases/${openId}`)).json.status).toBe("cancelled");
    expect((await m.get(`/purchases/${confirmedId}`)).json.status).toBe("confirmed");
    expect((await m.get(`/listings/${s.hash}`)).json.status).toBe("cancelled");
    expect((await buy(m, s, "citra")).json.error.code).toBe("listing_not_open");
    expect((await m.post(`/listings/${s.hash}/takedown`, { claim, evidence_hash: evidence, signature: signNoticeJson(message, CONTRACT, m.keys.dewi!.secretKey) })).json.error.code).toBe("already_exists");
  });

  it("TC-BE-056-09 the source goes through the SSRF guard: http, a name that resolves to a private address, and a source that does not answer are all refused", async () => {
    const m = await start();
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    const bad = async (ref: string, kind: "https" | "ipfs" = "https") => {
      const notice = { circle: CONTRACT, purchase_id: id, actor: acct("andi"), action: "cipher_posted", at: at(m), source: { kind, ref }, cipher_hash: contentHash(s.ciphertext) };
      return m.post(`/purchases/${id}`, { notice, signature: signNoticeJson(JSON.stringify(notice), CONTRACT, m.keys.andi!.secretKey) });
    };
    for (const ref of ["http://store.example.com/a.bin", "https://internal.example.com/a.bin", "https://127.0.0.1/a.bin", "https://169.254.169.254/latest/meta-data/", "https://user:pw@store.example.com/a.bin"]) {
      const r = await bad(ref);
      expect(r.status, ref).toBe(403);
      expect(r.json.error.code, ref).toBe("source_forbidden");
    }
    expect((await bad("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", "ipfs")).json.error.code).toBe("source_forbidden"); // CIDv0 cannot be verified
    const missing = await bad("https://store.example.com/missing.bin");
    expect(missing.status).toBe(409);
    expect(missing.json.error.code).toBe("purchase_bad_state");
    expect((await m.get(`/purchases/${id}`)).json.status).toBe("paid_held");
  });

  it("TC-BE-056-10 only the right party does the right step; the buyer leaves only after the window; the voucher is checked", async () => {
    const m = await start();
    const s = await sell(m);
    const v = (over: Partial<UnsignedVoucher>, who = "budi") => {
      const u: UnsignedVoucher = { circle: CONTRACT, payer: acct(who), payee: acct("andi"), epoch: 42, seq: 50, cumulativeAmount: C(50), unit: "credit", resource: licenseResource(s.docHash), ...over };
      return m.post(`/listings/${s.hash}/purchases`, { voucher: u, signature: signVoucher(u, m.keys[who]!.secretKey).signature });
    };
    expect((await v({ cumulativeAmount: C(10) })).status).toBe(400); // below the price
    expect((await v({ resource: "x207:license:" + "f".repeat(64) })).status).toBe(400);
    expect((await v({ payee: acct("citra") })).status).toBe(400);
    expect((await v({ epoch: 41 })).json.error.code).toBe("epoch_not_open");
    expect((await v({}, "citra")).status).toBe(201); // fine voucher of another buyer
    const id = (await buy(m, s)).json.purchase_id as string;
    expect((await postCipher(m, id, { ...s, doc: s.doc, ciphertext: s.ciphertext } as any)).status).toBe(201);
    const notice = { circle: CONTRACT, purchase_id: id, actor: acct("budi"), action: "cipher_posted", at: at(m), source: { kind: "https", ref: "https://store.example.com/d1.bin" }, cipher_hash: contentHash(s.ciphertext) };
    expect((await m.post(`/purchases/${id}`, { notice, signature: signNoticeJson(JSON.stringify(notice), CONTRACT, m.keys.budi!.secretKey) })).json.error.code).toBe("purchase_not_party");
    expect((await buyerNotice(m, id, "cancelled", "budi")).json.error.code).toBe("purchase_bad_state"); // too early
    m.clock.now += 73 * 3600 * 1000;
    expect((await buyerNotice(m, id, "cancelled", "budi")).json.status).toBe("cancelled");
    expect((await m.get(`/purchases/999`)).json.error.code).toBe("purchase_not_found");
  });

  it("TC-BE-056-11 the ciphertext is streamed through a temporary file: a mismatch is refused without being read, the file is deleted, and the deadline follows the size allowed", async () => {
    const before = () => readdirSync(tmpdir()).filter((n) => n.startsWith("x207-cipher-"));
    const left = before().length;
    files.clear();
    market = await startMarket(["andi", "budi", "citra", "dewi"], [], undefined, { sourceFetch: { resolver, transport }, maxCiphertextBytes: 4 * 1024 * 1024 });
    const m = market;
    openEpoch(m, 42);
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    const rel = releaseKey(m, id, s);
    await rel.post();
    const proof = { release: rel.release, signature: rel.signature, box_key: toHex(deriveBoxKey(Buffer.from(rel.release.sealed_key, "hex"), m.keys.budi!.secretKey)) };
    asked.length = 0;
    files.set("store.example.com/d1.bin", utf8("a different file"));
    expect((await buyerNotice(m, id, "disputed", "budi", "content_mismatch", proof)).json.error.code).toBe("proof_invalid");
    expect(asked).toEqual([{ timeoutMs: 64_000, maxBytes: 4 * 1024 * 1024, sink: true }]); // 60 s + 1 s per MiB allowed
    expect(before().length).toBe(left); // the temporary file is gone
    files.set("store.example.com/d1.bin", s.ciphertext);
    expect((await buyerNotice(m, id, "disputed", "budi", "content_mismatch", proof)).json.status).toBe("refuted");
    expect(before().length).toBe(left);
  });

  it("TC-BE-056-12 at most two ciphertexts are handled at once; the others wait their turn, and a failing one gives its place back", async () => {
    const sem = new Semaphore(MAX_DOWNLOADS);
    expect(MAX_DOWNLOADS).toBe(2);
    let running = 0;
    let peak = 0;
    const job = async (fail: boolean) => {
      await sem.acquire();
      try {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 15));
        if (fail) throw new Error("boom");
      } finally {
        running -= 1;
        sem.release();
      }
    };
    const results = await Promise.allSettled([job(false), job(true), job(false), job(false), job(true), job(false)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled", "rejected", "fulfilled"]);
    expect(peak).toBe(2);
    await sem.acquire();
    await sem.acquire(); // both places are free again
  });
});
