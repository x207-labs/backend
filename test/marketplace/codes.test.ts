import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_DISPUTE_WINDOW_SECONDS, UNVERIFIABLE_CODE_LIMIT, codeCommitment, codeDocumentHash, codeResource, createCodeRelease, createRelease, encryptCode, encryptContent, listingHash, makeCodeCheatProof, newCodeSalt, signVoucher,
  type CodeDocument, type UnsignedVoucher,
} from "@x207/core";
import { MockCodeIssuer } from "../../src/marketplace/code-issuers.js";
import { signNoticeJson } from "../../src/marketplace/notice.js";
import type { Transport } from "../../src/marketplace/ssrf.js";
import { acct, CONTRACT, openEpoch, signedListing, startMarket, type Market } from "./helpers.js";

const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const CODE = "GIFT-7QX2-LM9P-4KD8";

describe("BE-069 one-time codes: the code book on the fair exchange of BE-056", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });
  const files = new Map<string, Uint8Array>();
  const transport: Transport = async ({ host, path, method, onChunk }) => {
    const bytes = files.get(`${host}${path}`);
    if (!bytes) return { status: 404, body: Buffer.alloc(0), truncated: false };
    if (method === "HEAD") return { status: 200, body: Buffer.alloc(0), truncated: false };
    if (onChunk) {
      onChunk(Buffer.from(bytes));
      return { status: 200, body: Buffer.alloc(0), truncated: false };
    }
    return { status: 200, body: Buffer.from(bytes), truncated: false };
  };
  const issuer = new MockCodeIssuer();
  async function start(extra: Record<string, unknown> = {}) {
    files.clear();
    issuer.issue(CODE);
    market = await startMarket(["andi", "budi", "citra"], [], undefined, { sourceFetch: { resolver: async () => ["93.184.216.34"], transport }, codeIssuers: { acme: issuer }, ...extra });
    openEpoch(market, 42);
    return market;
  }
  const at = (m: Market) => Math.floor(m.clock.now / 1000);

  let n = 0;
  /** The seller makes the document of a code, encrypts it, and lists it. */
  async function sell(m: Market, o: { code?: string; value?: number; verifiable?: boolean; issuerName?: string; arbiter?: string | null; extraDetail?: Record<string, unknown>; salt?: Uint8Array; tamper?: boolean } = {}) {
    const code = o.code ?? CODE;
    const enc = encryptCode(code, o.salt === undefined ? {} : { salt: o.salt });
    const value = C(o.value ?? 10);
    const doc: CodeDocument = { circle: CONTRACT, seller: acct("andi"), code_commitment: enc.code_commitment, issuer: o.issuerName ?? "acme", value, verifiable: o.verifiable ?? true, arbiter: o.arbiter ?? null, nonce: `c${++n}` };
    const docHash = codeDocumentHash(doc);
    const detail = JSON.stringify({ kind: "code", code_doc: o.tamper ? "e".repeat(64) : docHash, code_commitment: doc.code_commitment, issuer: doc.issuer, verifiable: doc.verifiable, arbiter: doc.arbiter, nonce: doc.nonce, ...(o.extraDetail ?? {}) });
    const body = signedListing(m, "andi", { offer: { asset_type: "data:dataset", asset_class: "B", quantity: 1, value }, want: { asset_type: "usdc", asset_class: "A", quantity: 1, value }, detail, nonce: `code-${n}` });
    const posted = await m.post("/listings", body);
    return { code, enc, doc, docHash, body, hash: listingHash(body.listing), posted };
  }
  type Sold = Awaited<ReturnType<typeof sell>>;
  let seq = 0;
  const buy = (m: Market, s: Sold, who = "budi") => {
    const v: UnsignedVoucher = { circle: CONTRACT, payer: acct(who), payee: acct("andi"), epoch: 42, seq: ++seq, cumulativeAmount: s.doc.value, unit: "credit", resource: codeResource(s.docHash) };
    return m.post(`/listings/${s.hash}/purchases`, { voucher: v, signature: signVoucher(v, m.keys[who]!.secretKey).signature });
  };
  const postCipher = (m: Market, id: string, s: Sold) => {
    const ref = `https://store.example.com/${s.doc.nonce}.bin`;
    files.set(ref.replace("https://", ""), s.enc.ciphertext);
    const cipherHash = createRelease({ circle: CONTRACT, license_hash: s.docHash, buyer: acct("budi"), buyerPublicKey: m.keys.budi!.publicKey, content_hash: s.doc.code_commitment, content_size: 1, purchase_id: id, ciphertext: s.enc.ciphertext, contentKey: s.enc.key, at: at(m), sellerSecretKey: m.keys.andi!.secretKey }).release.cipher_hash;
    const notice = { circle: CONTRACT, purchase_id: id, actor: acct("andi"), action: "cipher_posted", at: at(m), source: { kind: "https", ref }, cipher_hash: cipherHash };
    return m.post(`/purchases/${id}`, { notice, signature: signNoticeJson(JSON.stringify(notice), CONTRACT, m.keys.andi!.secretKey) });
  };
  const release = (m: Market, id: string, s: Sold) => {
    const r = createCodeRelease({ doc: s.doc, code: s.code, salt: s.enc.salt, buyer: acct("budi"), buyerPublicKey: m.keys.budi!.publicKey, purchase_id: id, ciphertext: s.enc.ciphertext, contentKey: s.enc.key, at: at(m), sellerSecretKey: m.keys.andi!.secretKey });
    return { ...r, post: () => m.post(`/purchases/${id}`, { notice: r.release, signature: r.signature }) };
  };
  const check = (m: Market, s: Sold, over: { code?: string; salt?: string; who?: string; sigWho?: string; listing?: string } = {}) => {
    const notice = { circle: CONTRACT, listing_hash: over.listing ?? s.hash, actor: acct(over.who ?? "andi"), action: "check", at: at(m) };
    return m.post(`/listings/${s.hash}/code-check`, { notice, signature: signNoticeJson(JSON.stringify(notice), CONTRACT, m.keys[over.sigWho ?? over.who ?? "andi"]!.secretKey), code: over.code ?? s.code, salt: over.salt ?? hex(s.enc.salt) });
  };
  const buyerNotice = (m: Market, id: string, action: "confirmed" | "disputed" | "cancelled", who = "budi", reason: string | null = null, proof: unknown = null) => {
    const notice = { circle: CONTRACT, purchase_id: id, actor: acct(who), action, at: at(m), reason, proof };
    return m.post(`/purchases/${id}`, { notice, signature: signNoticeJson(JSON.stringify(notice), CONTRACT, m.keys[who]!.secretKey) });
  };
  const everythingStored = (m: Market): string => {
    const out: string[] = [];
    for (const t of m.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>) out.push(JSON.stringify(m.db.prepare(`SELECT * FROM "${t.name}"`).all(), (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    return out.join("\n");
  };

  it("TC-BE-069-01 the key of a code that can be checked is not released before a valid check; with it the key goes, the window is one hour, and the code and the salt are in no table and no answer", async () => {
    const m = await start();
    const s = await sell(m);
    expect(s.posted.status).toBe(201);
    const id = (await buy(m, s)).json.purchase_id as string;
    expect((await postCipher(m, id, s)).status).toBe(201);
    const early = await release(m, id, s).post();
    expect([early.status, early.json.error.code]).toEqual([409, "code_not_checked"]);
    const checked = await check(m, s);
    expect(checked.json).toMatchObject({ verdict: "valid", listingHash: s.hash });
    expect((await m.get(`/listings/${s.hash}/code-check`)).json).toMatchObject({ verifiable: true, verdict: "valid", fresh: true, issuer: "acme" });
    const released = await release(m, id, s).post();
    expect(released.status).toBe(201);
    expect(released.json).toMatchObject({ status: "key_released", kind: "code", needsBond: false });
    expect(released.json.disputeUntil - at(m)).toBe(CODE_DISPUTE_WINDOW_SECONDS);
    expect(JSON.stringify([checked.json, early.json, released.json, (await m.get(`/purchases/${id}`)).json])).not.toContain(CODE);
    const stored = everythingStored(m);
    expect(stored).not.toContain(CODE);
    expect(stored).not.toContain(hex(s.enc.salt));
    expect((await buyerNotice(m, id, "confirmed")).json.voucher).toMatchObject({ payer: acct("budi"), payee: acct("andi") });
  });

  it("TC-BE-069-02 a code that the issuer says is used ends the sale: the check cancels the open purchase and the listing, nothing is paid, and nobody can buy it after", async () => {
    const m = await start();
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    expect((await check(m, s)).json.verdict).toBe("valid");
    issuer.markUsed(CODE);
    const used = await check(m, s);
    expect(used.json).toMatchObject({ verdict: "used", validUntilMs: null });
    const p = (await m.get(`/purchases/${id}`)).json;
    expect(p).toMatchObject({ status: "cancelled", disputeReason: "code_used" });
    expect("voucher" in p).toBe(false);
    expect((await release(m, id, s).post()).json.error.code).toBe("purchase_bad_state");
    expect((await buy(m, s, "citra")).json.error.code).toBe("listing_not_open");
    expect((await m.get(`/listings/${s.hash}/code-check`)).json).toMatchObject({ verdict: "used", listingStatus: "cancelled" });
  });

  it("TC-BE-069-03 a code that was used before the release stops the key: the stored verdict is used, the release is 409 code_used and the purchase is cancelled", async () => {
    const m = await start();
    const s = await sell(m, { code: "OTHER-CODE-0001" });
    issuer.issue("OTHER-CODE-0001");
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    await check(m, s);
    // the verdict in the book turns to used by another check of a second purchase path: simulate the row (the listing is still open)
    m.db.prepare("UPDATE code_checks SET verdict = 'used' WHERE listing_hash = ?").run(s.hash);
    const r = await release(m, id, s).post();
    expect([r.status, r.json.error.code]).toEqual([409, "code_used"]);
    expect((await m.get(`/purchases/${id}`)).json).toMatchObject({ status: "cancelled", disputeReason: "code_used" });
    m.db.prepare("UPDATE code_checks SET verdict = 'unknown' WHERE listing_hash = ?").run(s.hash);
  });

  it("TC-BE-069-04 an old verdict is not enough, and a code the issuer does not know does not release the key", async () => {
    const m = await start({ codeCheckTtlSeconds: 60 });
    const s = await sell(m, { code: "NOBODY-KNOWS-ME" });
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    const unknown = await check(m, s);
    expect(unknown.json.verdict).toBe("unknown");
    const r = await release(m, id, s).post();
    expect([r.status, r.json.error.code]).toEqual([409, "code_unknown"]);
    expect((await m.get(`/purchases/${id}`)).json.status).toBe("cipher_posted"); // not cancelled: the seller can fix and check again
    issuer.issue("NOBODY-KNOWS-ME");
    expect((await check(m, s)).json.verdict).toBe("valid");
    m.clock.now += 61_000;
    expect((await release(m, id, s).post()).json.error.code).toBe("code_not_checked");
    await check(m, s);
    expect((await release(m, id, s).post()).status).toBe(201);
  });

  it("TC-BE-069-05 the window of a code is one hour: still key_released at 59 minutes, confirmed by silence after 60", async () => {
    const m = await start();
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    await check(m, s);
    await release(m, id, s).post();
    m.clock.now += 59 * 60_000;
    expect((await m.get(`/purchases/${id}`)).json.status).toBe("key_released");
    m.clock.now += 2 * 60_000;
    expect((await m.get(`/purchases/${id}`)).json).toMatchObject({ status: "confirmed", autoConfirmed: true });
  });

  it("TC-BE-069-06 the caps hold whatever the arbiter says: 20 credit for a code that cannot be checked, 100 for one that can; an arbiter is refused (ADR-48 points 6 and 7)", async () => {
    const m = await start();
    expect(UNVERIFIABLE_CODE_LIMIT).toBe(C(20));
    expect((await sell(m, { verifiable: false, value: 20 })).posted.status).toBe(201);
    const over = await sell(m, { verifiable: false, value: 21 });
    expect([over.posted.status, over.posted.json.error.code]).toEqual([400, "code_over_limit_unbonded"]);
    expect((await sell(m, { verifiable: true, value: 100 })).posted.status).toBe(201);
    const rich = await sell(m, { verifiable: true, value: 5000 });
    expect([rich.posted.status, rich.posted.json.error.code]).toEqual([400, "code_over_limit_unbonded"]);
    expect((await sell(m, { verifiable: true, value: 101 })).posted.json.error.code).toBe("code_over_limit_unbonded");
    // an arbiter is only a name: it lifts no cap and is not accepted
    for (const [verifiable, value] of [[false, 21], [false, 5], [true, 500]] as const) {
      const r = await sell(m, { verifiable, value, arbiter: acct("citra") });
      expect([r.posted.status, r.posted.json.error.code], `${verifiable} ${value}`).toEqual([400, "arbiter_not_supported"]);
    }
    // no check for a code that has none
    const free = await sell(m, { verifiable: false, value: 5 });
    expect((await check(m, free)).json.error.code).toBe("code_not_verifiable");
    // and its key goes without a check
    const id = (await buy(m, free)).json.purchase_id as string;
    await postCipher(m, id, free);
    expect((await release(m, id, free).post()).status).toBe(201);
  });

  it("TC-BE-069-07 the same code can be listed twice (a salted commitment says nothing about equality), but one listing is sold once", async () => {
    const m = await start();
    const a = await sell(m);
    const b = await sell(m);
    expect([a.posted.status, b.posted.status]).toEqual([201, 201]);
    expect(a.enc.code_commitment).not.toBe(b.enc.code_commitment);
    expect((await buy(m, a)).status).toBe(201);
    const second = await buy(m, a, "citra");
    expect([second.status, second.json.error.code]).toEqual([409, "exclusive_taken"]);
  });

  it("TC-BE-069-08 the listing is checked: a document that does not hash to code_doc, an issuer that is not registered, a code bound to an identity", async () => {
    const m = await start();
    const bad = await sell(m, { tamper: true });
    expect([bad.posted.status, bad.posted.json.error.code]).toEqual([400, "scope_invalid"]);
    const unknown = await sell(m, { issuerName: "nobody" });
    expect([unknown.posted.status, unknown.posted.json.error.code]).toEqual([400, "code_issuer_unknown"]);
    const bound = await sell(m, { extraDetail: { identity_bound: true } });
    expect([bound.posted.status, bound.posted.json.error.code]).toEqual([400, "code_bound_to_identity"]);
  });

  it("TC-BE-069-09 the check route: only the seller, a valid signature, the right salt and code; a down issuer is 503 and decides nothing; no error holds the code", async () => {
    const m = await start();
    const s = await sell(m);
    const results = [
      await check(m, s, { who: "budi" }), // not the seller
      await check(m, s, { sigWho: "budi" }), // seller named, signed by another key
      await check(m, s, { salt: hex(newCodeSalt()) }), // wrong salt
      await check(m, s, { code: "A-DIFFERENT-CODE" }), // wrong code
      await check(m, s, { code: "short" }), // not a code
      await check(m, s, { listing: "f".repeat(64) }), // the signed listing is another one
    ];
    expect(results.map((r) => [r.status, r.json.error.code])).toEqual([[403, "purchase_not_party"], [401, "invalid_signature"], [400, "code_bad_commitment"], [400, "code_bad_commitment"], [400, "code_bad_code"], [400, "invalid_request"]]);
    expect(JSON.stringify(results.map((r) => r.json))).not.toContain(CODE);
    expect(JSON.stringify(results.map((r) => r.json))).not.toContain("A-DIFFERENT-CODE");
    issuer.unavailable = true;
    const down = await check(m, s);
    expect([down.status, down.json.error.code]).toEqual([503, "code_issuer_unavailable"]);
    issuer.unavailable = false;
    expect((await m.get(`/listings/${s.hash}/code-check`)).json.verdict).toBeNull(); // nothing was decided
    expect((await check(m, s)).json.verdict).toBe("valid");
  });

  it("TC-BE-069-11 the same code in a second live listing is refused code_duplicate at the check (HMAC with the key of the operator); a closed first listing frees it; a sold one does not; no key, no detection; the table has no plain hash", async () => {
    const m = await start({ codeSeenKey: "operator-secret" });
    const a = await sell(m);
    const b = await sell(m); // the same code, another salt, so another commitment
    expect((await check(m, a)).json.verdict).toBe("valid");
    const dup = await check(m, b);
    expect([dup.status, dup.json.error.code, dup.json.error.details.otherListing]).toEqual([409, "code_duplicate", a.hash]);
    expect(JSON.stringify(dup.json)).not.toContain(CODE);
    expect(issuer.calls).toBeGreaterThan(0);
    // what is stored is an HMAC: neither the code nor sha256 of it
    const macs = (m.db.prepare("SELECT mac FROM code_seen").all() as Array<{ mac: string }>).map((r) => r.mac);
    expect(macs).toHaveLength(1);
    const { createHash } = await import("node:crypto");
    expect(macs[0]).not.toBe(createHash("sha256").update(`acme\u0000${CODE}`).digest("hex"));
    expect(macs[0]).not.toBe(createHash("sha256").update(CODE).digest("hex"));
    // the first listing is cancelled: the code is free for the second
    m.db.prepare("UPDATE listings SET status = 'cancelled' WHERE listing_hash = ?").run(a.hash);
    expect((await check(m, b)).json.verdict).toBe("valid");
    // sold: a purchase of b makes it unavailable to a third listing
    const c = await sell(m);
    const id = (await buy(m, b)).json.purchase_id as string;
    expect(id).toBeDefined();
    expect((await check(m, c)).json.error.code).toBe("code_duplicate");
    // the same seller checking the same listing again is not a duplicate of itself
    expect((await check(m, b)).json.verdict).toBe("valid");
  });

  it("TC-BE-069-12 without X207_CODE_SEEN_KEY nothing is detected; a code that cannot be checked is not looked at", async () => {
    const m = await start();
    const a = await sell(m);
    const b = await sell(m);
    expect((await check(m, a)).json.verdict).toBe("valid");
    expect((await check(m, b)).json.verdict).toBe("valid");
    expect((m.db.prepare("SELECT COUNT(*) AS n FROM code_seen").get() as { n: number }).n).toBe(0);
  });

  it("TC-BE-069-13 a release of a code that is not short (a payload of megabytes) is refused: a code is a salt and at most 1024 bytes", async () => {
    const m = await start();
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    await check(m, s);
    const big = createRelease({ circle: CONTRACT, license_hash: s.docHash, buyer: acct("budi"), buyerPublicKey: m.keys.budi!.publicKey, content_hash: s.doc.code_commitment, content_size: 5_000_000, purchase_id: id, ciphertext: s.enc.ciphertext, contentKey: s.enc.key, at: at(m), sellerSecretKey: m.keys.andi!.secretKey });
    const refused = await m.post(`/purchases/${id}`, { notice: big.release, signature: big.signature });
    expect([refused.status, refused.json.error.code]).toEqual([400, "invalid_request"]);
    expect((await release(m, id, s).post()).status).toBe(201); // the honest release goes through
  });

  it("TC-BE-069-14 a buyer who says other, pii or used without a proof of cheating makes a complaint, one per purchase; the sale goes on to the automatic confirmation and the seller is paid (ADR-48 points 5 to 7)", async () => {
    const m = await start();
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    await check(m, s);
    await release(m, id, s).post();
    // a buyer that has paid somebody before counts as a source of complaints
    m.db.prepare("INSERT INTO epochs (circle_id, epoch, phase) VALUES ('agents-main', 42, 'open') ON CONFLICT DO NOTHING").run();
    m.db.prepare("INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, registration_mode, registered_block, receipt_id) VALUES ('agents-main', 42, ?, ?, 1, 5000000, 'cumulative', 1, 'r1')").run(acct("budi"), acct("citra"));
    const before = (await m.get(`/reputation/${acct("andi")}`)).json;
    expect(before.complaints).toEqual({ transactions: 0, counterparties: 0 });
    const complaint = await buyerNotice(m, id, "disputed", "budi", "other", null);
    expect([complaint.status, complaint.json.complaint, complaint.json.status]).toEqual([201, true, "key_released"]);
    expect("voucher" in complaint.json).toBe(false);
    expect((await buyerNotice(m, id, "disputed", "budi", "contains_pii", null)).json.error.code).toBe("already_exists"); // one per purchase
    expect((await buyerNotice(m, id, "disputed", "budi", "other", { release: {} })).json.error.code).toBe("invalid_request"); // a proof belongs to content_mismatch only
    // content_mismatch without a proof is still refused: only a proof of cheating stops the sale
    expect((await buyerNotice(m, id, "disputed", "budi", "content_mismatch", null)).json.error.code).toBe("proof_invalid");
    expect((await m.get(`/purchases/${id}`)).json.status).toBe("key_released");
    // silence for one hour: confirmed, the voucher is shown to the seller side
    m.clock.now += 61 * 60_000;
    const done = (await m.get(`/purchases/${id}`)).json;
    expect(done).toMatchObject({ status: "confirmed", autoConfirmed: true });
    expect(done.voucher).toMatchObject({ payer: acct("budi"), payee: acct("andi") });
    // the reputation of the seller: one completed sale and one complaint
    const after = (await m.get(`/reputation/${acct("andi")}`)).json;
    expect(after.complaints).toEqual({ transactions: 1, counterparties: 1 });
    expect(after.completed).toEqual({ transactions: 1, counterparties: 1 });
    expect(after.completionRate).toBe(0.5);
    // a complaint of a buyer that has paid nobody does not count
    const t = await sell(m);
    const id2 = (await buy(m, t, "citra")).json.purchase_id as string;
    await postCipher(m, id2, t);
    await check(m, t);
    const r2 = createCodeRelease({ doc: t.doc, code: t.code, salt: t.enc.salt, buyer: acct("citra"), buyerPublicKey: m.keys.citra!.publicKey, purchase_id: id2, ciphertext: t.enc.ciphertext, contentKey: t.enc.key, at: at(m), sellerSecretKey: m.keys.andi!.secretKey });
    await m.post(`/purchases/${id2}`, { notice: r2.release, signature: r2.signature });
    expect((await buyerNotice(m, id2, "disputed", "citra", "other", null)).json.complaint).toBe(true);
    expect((await m.get(`/reputation/${acct("andi")}`)).json.complaints.counterparties).toBe(1); // citra has paid nobody
  });

  it("TC-BE-078-C1 a takedown cannot end a code sale after the key is out: the buyer files none, and the takedown of another member leaves the released purchase alone (B7-C1)", async () => {
    const m = await start();
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    await check(m, s);
    expect((await release(m, id, s).post()).status).toBe(201);
    const takedown = (who: string) => {
      const body = { claim: "this code is mine", evidence_hash: "" };
      const message = JSON.stringify({ circle: CONTRACT, listing_hash: s.hash, claim: body.claim, evidence_hash: body.evidence_hash });
      return m.post(`/listings/${s.hash}/takedown`, { ...body, signature: signNoticeJson(message, CONTRACT, m.keys[who]!.secretKey) });
    };
    const byBuyer = await takedown("budi");
    expect([byBuyer.status, byBuyer.json.error.code]).toEqual([400, "takedown_invalid"]);
    expect((await m.get(`/purchases/${id}`)).json.status).toBe("key_released");
    const byOther = await takedown("citra");
    expect([byOther.status, byOther.json.cancelledPurchases]).toEqual([201, 0]);
    expect((await m.get(`/purchases/${id}`)).json.status).toBe("key_released");
    m.clock.now += 61 * 60_000;
    expect((await m.get(`/purchases/${id}`)).json.status).toBe("confirmed"); // the seller is paid
  });

  it("TC-BE-078-C2 the key of a code is not released for a source that serves other bytes, and a source that no longer serves the signed ciphertext ends the sale disputed whatever the reason (B7-C2)", async () => {
    const m = await start();
    const s = await sell(m);
    const id = (await buy(m, s)).json.purchase_id as string;
    await postCipher(m, id, s);
    await check(m, s);
    const key = `store.example.com/${s.doc.nonce}.bin`;
    files.set(key, new Uint8Array(s.enc.ciphertext.length).fill(7));
    const bad = await release(m, id, s).post();
    expect([bad.status, bad.json.error.code]).toEqual([400, "proof_invalid"]);
    expect((await m.get(`/purchases/${id}`)).json.status).toBe("cipher_posted");
    files.set(key, s.enc.ciphertext);
    expect((await release(m, id, s).post()).status).toBe(201);
    // the source goes away: the buyer cannot open the code, and a complaint of any kind holds the voucher
    files.delete(key);
    const disputed = await buyerNotice(m, id, "disputed", "budi", "other", null);
    expect([disputed.status, disputed.json.status, disputed.json.notDelivered]).toEqual([201, "disputed", true]);
    expect("voucher" in disputed.json).toBe(false);
    m.clock.now += 61 * 60_000;
    expect((await m.get(`/purchases/${id}`)).json.status).toBe("disputed"); // no automatic confirmation, the seller is not paid
  });

  it("TC-BE-069-10 a seller who encrypts another code than the commitment is caught by the proof of cheating of the fair exchange", async () => {
    const m = await start();
    const s = await sell(m);
    const wrong = encryptCode("A-COMPLETELY-OTHER-CODE", { salt: s.enc.salt });
    const id = (await buy(m, s)).json.purchase_id as string;
    await check(m, s);
    files.set(`store.example.com/${s.doc.nonce}.bin`, wrong.ciphertext);
    const rel = createRelease({ circle: CONTRACT, license_hash: s.docHash, buyer: acct("budi"), buyerPublicKey: m.keys.budi!.publicKey, content_hash: s.doc.code_commitment, content_size: 32 + CODE.length, purchase_id: id, ciphertext: wrong.ciphertext, contentKey: wrong.key, at: at(m), sellerSecretKey: m.keys.andi!.secretKey });
    const notice = { circle: CONTRACT, purchase_id: id, actor: acct("andi"), action: "cipher_posted", at: at(m), source: { kind: "https", ref: `https://store.example.com/${s.doc.nonce}.bin` }, cipher_hash: rel.release.cipher_hash };
    expect((await m.post(`/purchases/${id}`, { notice, signature: signNoticeJson(JSON.stringify(notice), CONTRACT, m.keys.andi!.secretKey) })).status).toBe(201);
    expect((await m.post(`/purchases/${id}`, { notice: rel.release, signature: rel.signature })).json.status).toBe("key_released");
    const proof = makeCodeCheatProof({ ciphertext: wrong.ciphertext, release: rel.release, signature: rel.signature, sellerPublicKey: m.keys.andi!.publicKey, buyerSecretKey: m.keys.budi!.secretKey });
    const disputed = await buyerNotice(m, id, "disputed", "budi", "content_mismatch", { release: proof.release, signature: proof.signature, box_key: proof.box_key });
    expect(disputed.json).toMatchObject({ status: "disputed", disputeReason: "content_mismatch" });
    expect("voucher" in disputed.json).toBe(false);
    expect(codeCommitment(CODE, s.enc.salt)).toBe(s.doc.code_commitment);
  });
});
