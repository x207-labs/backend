import { afterEach, describe, expect, it } from "vitest";
import { abuseFromEnv, accountOfBody, DEFAULT_LIMITS, WindowCounter } from "../../src/api/abuse.js";
import { acct, NOW_S, openEpoch, signedListing, startMarket, type Market } from "./helpers.js";
import { openOrder, orderDoc, signOrder } from "./order-helpers.js";
import { requestBody } from "./invoice-helpers.js";

describe("BE-066 limits against abuse of the write routes", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });
  const start = async (names: string[], abuse: Parameters<typeof startMarket>[4] = {}, routeOptions: Parameters<typeof startMarket>[3] = {}) => {
    market = await startMarket(names, [], undefined, routeOptions, abuse);
    openEpoch(market, 42);
    return market;
  };
  let nonce = 0;
  const listing = (m: Market, who: string) => m.post("/listings", signedListing(m, who, { nonce: `ab${++nonce}`, expires_at: NOW_S + 3600 }));
  const call = async (m: Market, method: "GET" | "POST", path: string, body?: unknown, raw?: string) => {
    const res = await fetch(`${m.srv.url}/x207/circles/agents-main${path}`, { method, ...(body === undefined && raw === undefined ? {} : { headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }) });
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  };

  it("TC-BE-066-01 a flood of writes from one address is answered 429 rate_limited with Retry-After, also when each write is refused; reads are not counted; the window resets", async () => {
    const m = await start(["andi"], { abuse: { writeIpPerMinute: 3 } });
    for (let i = 0; i < 3; i++) expect((await call(m, "POST", "/intents", {})).status, `write ${i}`).toBe(400);
    const blocked = await call(m, "POST", "/intents", {});
    expect([blocked.status, blocked.json.error.code, blocked.json.error.details.scope]).toEqual([429, "rate_limited", "ip_write"]);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await call(m, "GET", "/members")).status).toBe(200); // reading is not a write
    m.clock.now += 61_000;
    expect((await call(m, "POST", "/intents", {})).status).toBe(400);
  });

  it("TC-BE-066-02 the limit per account counts accepted writes only: another account is not touched, and a refused request that names an account costs it nothing", async () => {
    const m = await start(["andi", "budi"], { abuse: { writeAccountPerMinute: 2 } });
    for (let i = 0; i < 4; i++) {
      const forged = signedListing(m, "andi", { nonce: `forged${i}`, expires_at: NOW_S + 3600 });
      expect((await m.post("/listings", { ...forged, signature: signedListing(m, "budi", { nonce: `forged${i}`, expires_at: NOW_S + 3600 }).signature })).status).toBe(401);
    }
    expect((await listing(m, "andi")).status).toBe(201);
    expect((await listing(m, "andi")).status).toBe(201);
    const third = await call(m, "POST", "/listings", signedListing(m, "andi", { nonce: "ab-x", expires_at: NOW_S + 3600 }));
    expect([third.status, third.json.error.code, third.json.error.details.scope, third.json.error.details.account]).toEqual([429, "rate_limited", "account_write", acct("andi")]);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await listing(m, "budi")).status).toBe(201);
    m.clock.now += 61_000;
    expect((await listing(m, "andi")).status).toBe(201);
  });

  it("TC-BE-066-03 a body above the limit is 413 payload_too_large; one inside it is read", async () => {
    const m = await start(["andi"], { abuse: { maxBodyBytes: 2048 } });
    const big = await call(m, "POST", "/intents", undefined, JSON.stringify({ pad: "x".repeat(4000) }));
    expect([big.status, big.json.error.code, big.json.error.details.maxBytes]).toEqual([413, "payload_too_large", 2048]);
    expect((await call(m, "POST", "/intents", {})).status).toBe(400);
    expect((await call(m, "POST", "/intents", undefined, "not json")).json.error.code).toBe("invalid_request");
  });

  it("TC-BE-066-04 the size of a page: above the configured maximum is 400, at it is served; never above 200", async () => {
    const m = await start(["andi"], { abuse: { maxPageLimit: 10 } });
    expect((await call(m, "GET", "/members?limit=10")).status).toBe(200);
    const over = await call(m, "GET", "/members?limit=11");
    expect([over.status, over.json.error.code, over.json.error.details.max]).toEqual([400, "invalid_request", 10]);
    await m.srv.close();
    m.db.close();
    const open = await start(["andi"], {});
    expect((await call(open, "GET", "/members?limit=201")).status).toBe(400);
    expect((await call(open, "GET", "/members?limit=200")).status).toBe(200);
  });

  it("TC-BE-066-06 open orders: an account at the cap gets 409 open_limit_reached for a new order, other accounts are not touched; an order that exists is not a new object", async () => {
    const m = await start(["andi", "budi", "citra", "dewi"], {}, { openLimits: { orders: 2 } });
    const a = orderDoc("andi", "budi", { nonce: "o1" });
    await openOrder(m, a);
    await openOrder(m, orderDoc("andi", "budi", { nonce: "o2" }));
    const third = orderDoc("andi", "budi", { nonce: "o3" });
    const over = await m.post("/orders", { order: third, signatures: [signOrder(m, third, "andi"), signOrder(m, third, "budi")] });
    expect([over.status, over.json.error.code, over.json.error.details.limit]).toEqual([409, "open_limit_reached", 2]);
    await openOrder(m, orderDoc("citra", "dewi", { nonce: "o4" }));
    const dup = await m.post("/orders", { order: a, signatures: [signOrder(m, a, "andi"), signOrder(m, a, "budi")] });
    expect(dup.json.error.code).toBe("order_duplicate");
  });

  it("TC-BE-066-07 open invoices: an issuer at the cap gets 409 open_limit_reached, another issuer is not touched", async () => {
    const m = await start(["andi", "budi", "citra"], {}, { openLimits: { invoices: 2 } });
    expect((await m.post("/invoices", requestBody(m, "andi", "budi", 2, { id: "I1" }))).status).toBe(201);
    expect((await m.post("/invoices", requestBody(m, "andi", "budi", 2, { id: "I2" }))).status).toBe(201);
    const over = await m.post("/invoices", requestBody(m, "andi", "citra", 2, { id: "I3" }));
    expect([over.status, over.json.error.code, over.json.error.details.limit]).toEqual([409, "open_limit_reached", 2]);
    expect((await m.post("/invoices", requestBody(m, "budi", "andi", 2, { id: "I4" }))).status).toBe(201);
  });

  it("TC-BE-066-08 the settings come from the environment with defaults; a bad value names the variable; the account of a body is read from the places the routes keep it", () => {
    expect(abuseFromEnv({}).limits).toEqual(DEFAULT_LIMITS);
    const set = abuseFromEnv({ API_WRITE_RATE_PER_MINUTE_IP: "7", API_WRITE_RATE_PER_MINUTE_ACCOUNT: "3", API_MAX_BODY_BYTES: "4096", API_MAX_PAGE_LIMIT: "500", API_TRUST_PROXY: "1", API_MAX_OPEN_ORDERS: "5", API_MAX_OPEN_INVOICES: "6", API_MAX_OPEN_PURCHASES: "7" });
    expect(set.limits).toMatchObject({ writeIpPerMinute: 7, writeAccountPerMinute: 3, maxBodyBytes: 4096, maxPageLimit: 200, trustProxy: true });
    expect(set.open).toEqual({ orders: 5, invoices: 6, purchases: 7 });
    expect(() => abuseFromEnv({ API_MAX_BODY_BYTES: "10" })).toThrow(/API_MAX_BODY_BYTES/);
    expect(() => abuseFromEnv({ API_MAX_OPEN_ORDERS: "x" })).toThrow(/API_MAX_OPEN_ORDERS/);
    expect(accountOfBody({ notice: { actor: "a.near" } })).toBe("a.near");
    expect(accountOfBody({ listing: { account: "b.near" } })).toBe("b.near");
    expect(accountOfBody({ voucher: { payer: "c.near" } })).toBe("c.near");
    expect(accountOfBody({ order: { buyer: "d.near" } })).toBe("d.near");
    expect(accountOfBody({})).toBeNull();
    expect(accountOfBody(null)).toBeNull();
    const counter = new WindowCounter();
    expect(counter.wait("k", 1, 0)).toBe(0);
    counter.add("k", 0);
    expect(counter.wait("k", 1, 1000)).toBe(59);
    expect(counter.wait("k", 1, 60_000)).toBe(0);
  });

  it("TC-BE-066-09 behind a proxy you run, the last hop of X-Forwarded-For is the caller; without it the header is ignored", async () => {
    const m = await start(["andi"], { abuse: { writeIpPerMinute: 1, trustProxy: true } });
    const post = (ip: string) => fetch(`${m.srv.url}/x207/circles/agents-main/intents`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `1.1.1.1, ${ip}` }, body: "{}" }).then((r) => r.status);
    expect(await post("9.9.9.1")).toBe(400);
    expect(await post("9.9.9.1")).toBe(429);
    expect(await post("9.9.9.2")).toBe(400);
    await m.srv.close();
    m.db.close();
    const plain = await start(["andi"], { abuse: { writeIpPerMinute: 1 } });
    const post2 = (ip: string) => fetch(`${plain.srv.url}/x207/circles/agents-main/intents`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: "{}" }).then((r) => r.status);
    expect(await post2("9.9.9.1")).toBe(400);
    expect(await post2("9.9.9.2")).toBe(429);
  });
});
