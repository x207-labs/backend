import { afterEach, describe, expect, it } from "vitest";
import { listingHash, signCancelListing } from "@x207/core";
import { acct, listing, NOW_S, signedListing, startMarket, type Market } from "./helpers.js";

describe("BE-040 listing book D12", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  it("a listing is stored without a counterparty, read by hash and through the list", async () => {
    market = await startMarket();
    const m = market;
    const body = signedListing(m, "andi");
    const created = await m.post("/listings", body);
    expect(created.status).toBe(201);
    expect(created.json.listingHash).toBe(listingHash(body.listing));
    expect(created.json).toMatchObject({
      account: acct("andi"), status: "open", discountBps: 1000, acceptPayment: true, discoverable: true,
      offer: { assetType: "gpu-hours", assetClass: "A", quantity: 10, value: "100000000" },
      want: { assetType: "translation", assetClass: "B", quantity: 5, value: "100000000" },
      terms: "deliver within 24h", detail: "A100 80GB, batch inference", expiresAt: "2026-11-05T10:00:00Z",
    });
    const one = await m.get(`/listings/${created.json.listingHash}`);
    expect(one.status).toBe(200);
    expect(one.json).toEqual(created.json);
    const list = await m.get("/listings");
    expect(list.json.items).toHaveLength(1);
    expect(list.json.nextCursor).toBeNull();
    expect((await m.get(`/listings/${"0".repeat(64)}`)).json.error.code).toBe("listing_not_found");
    expect((await m.get("/listings/xyz")).status).toBe(400);
  });

  it("filters: asset, class, lister, discoverable and accept_payment", async () => {
    market = await startMarket();
    const m = market;
    await m.post("/listings", signedListing(m, "andi"));
    await m.post("/listings", signedListing(m, "budi", {
      offer: { asset_type: "translation", asset_class: "B", quantity: 5, value: "100000000" },
      want: { asset_type: "gpu-hours", asset_class: "A", quantity: 10, value: "100000000" },
      discoverable: false, accept_payment: false,
    }));
    const accounts = async (q: string) => (await m.get(`/listings?${q}`)).json.items.map((i: any) => i.account);
    expect(await accounts("offerType=gpu-hours")).toEqual([acct("andi")]);
    expect(await accounts("wantType=gpu-hours")).toEqual([acct("budi")]);
    expect(await accounts("offerClass=B")).toEqual([acct("budi")]);
    expect(await accounts("wantClass=B")).toEqual([acct("andi")]);
    expect(await accounts(`account=${acct("budi")}`)).toEqual([acct("budi")]);
    expect(await accounts("discoverable=true")).toEqual([acct("andi")]);
    expect(await accounts("acceptPayment=false")).toEqual([acct("budi")]);
    expect((await m.get("/listings?discoverable=maybe")).status).toBe(400);
    expect((await m.get("/listings?status=zzz")).status).toBe(400);
  });

  it("an expired listing disappears from the open results and appears in expired", async () => {
    market = await startMarket();
    const m = market;
    const l = await m.post("/listings", signedListing(m, "andi", { expires_at: NOW_S + 60 }));
    expect(l.status).toBe(201);
    expect((await m.get("/listings")).json.items).toHaveLength(1);
    m.clock.now = (NOW_S + 61) * 1000;
    expect((await m.get("/listings")).json.items).toHaveLength(0);
    const expired = await m.get("/listings?status=expired");
    expect(expired.json.items.map((i: any) => i.status)).toEqual(["expired"]);
    expect((await m.get(`/listings/${l.json.listingHash}`)).json.status).toBe("expired");
    expect((await m.get("/listings?status=all")).json.items).toHaveLength(1);
  });

  it("cancellation signed by the lister; another party or a repeated cancellation is rejected", async () => {
    market = await startMarket();
    const m = market;
    const body = signedListing(m, "andi");
    const hash = (await m.post("/listings", body)).json.listingHash;
    const forged = await m.post(`/listings/${hash}/cancel`, { signature: signCancelListing(body.listing, m.keys.budi!.secretKey) });
    expect(forged.status).toBe(401);
    expect(forged.json.error.code).toBe("invalid_signature");
    expect((await m.post(`/listings/${hash}/cancel`, {})).status).toBe(400);
    const ok = await m.post(`/listings/${hash}/cancel`, { signature: signCancelListing(body.listing, m.keys.andi!.secretKey) });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("cancelled");
    expect((await m.get("/listings")).json.items).toHaveLength(0);
    expect((await m.get("/listings?status=cancelled")).json.items).toHaveLength(1);
    const again = await m.post(`/listings/${hash}/cancel`, { signature: signCancelListing(body.listing, m.keys.andi!.secretKey) });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("listing_not_open");
  });

  it("rejects a wrong signature, an inactive member, a duplicate, a wrong circle, expiry and format", async () => {
    market = await startMarket(["andi", "budi"], ["gita"]);
    const m = market;
    const good = signedListing(m, "andi");
    expect((await m.post("/listings", { listing: good.listing, signature: signedListing(m, "budi").signature })).json.error.code).toBe("invalid_signature");
    expect((await m.post("/listings", signedListing(m, "gita"))).json.error.code).toBe("member_not_active");
    expect((await m.post("/listings", good)).status).toBe(201);
    const dup = await m.post("/listings", good);
    expect([dup.status, dup.json.error.code]).toEqual([409, "already_exists"]);
    expect((await m.post("/listings", signedListing(m, "budi", { circle: "other.near" }))).status).toBe(400);
    expect((await m.post("/listings", signedListing(m, "budi", { expires_at: 1 }))).status).toBe(400);
    expect((await m.post("/listings", { listing: listing("budi", { discount_bps: 10_001 }), signature: "ed25519:x" })).status).toBe(400);
    expect((await m.post("/listings", [])).status).toBe(400);
  });

  it("pagination with cursor", async () => {
    market = await startMarket();
    const m = market;
    for (const name of ["andi", "budi", "citra"]) await m.post("/listings", signedListing(m, name));
    const first = await m.get("/listings?limit=2");
    expect(first.json.items).toHaveLength(2);
    const second = await m.get(`/listings?limit=2&cursor=${first.json.nextCursor}`);
    expect(second.json.items.map((i: any) => i.account)).toEqual([acct("citra")]);
  });

  it("TC-BE-119-17 a listing whose detail names a done appraisal carries it in `appraisal`; others do not", async () => {
    market = await startMarket();
    const m = market;
    const id = `apr_${"c".repeat(24)}`;
    m.db.prepare(
      `INSERT INTO appraisals (appraisal_id, input_hash, ip, state, asset_json, model, rubric_version, rubric_hash, result_json, signature_ok, attestation_verdict, created_at_ms, completed_at_ms)
       VALUES (?, ?, '1.2.3.4', 'done', '{}', 'z-ai/glm-5.3-flash', 'v1', ?, ?, 1, 'not_checked', 1, 2)`,
    ).run(id, "c".repeat(64), "d".repeat(64), JSON.stringify({ value_credits: "100", range: { low: "80", high: "120" }, confidence: 0.6, rationale: "r", flags: [] }));
    const withIt = await m.post("/listings", signedListing(m, "andi", { detail: `A100 80GB, batch inference | appraisal=${id}` }));
    expect(withIt.status).toBe(201);
    expect(withIt.json.appraisal).toEqual({
      appraisal_id: id, model: "z-ai/glm-5.3-flash", value_credits: "100", range: { low: "80", high: "120" }, confidence: 0.6, flags: [],
      verified: { signature: true, attestation: "not_checked" }, rubric_hash: "d".repeat(64), url: `/x207/appraisals/${id}`,
    });
    expect((await m.get(`/listings/${withIt.json.listingHash}`)).json.appraisal.appraisal_id).toBe(id);
    const without = await m.post("/listings", signedListing(m, "budi", { detail: `appraisal=apr_${"e".repeat(24)}` }));
    expect(without.json).not.toHaveProperty("appraisal");
    const items = (await m.get("/listings")).json.items;
    expect(items.filter((i: any) => i.appraisal).map((i: any) => i.account)).toEqual([acct("andi")]);
  });
});
