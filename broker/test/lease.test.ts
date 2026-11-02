import { describe, expect, it } from "vitest";
import { validatePaymentRequirements } from "@x207/core";
import { Dispatcher } from "../src/dispatcher.js";
import { ClassBAdapter, DAY_MS } from "../src/keys/class-b.js";
import { createBrokerHandler, creditPrice } from "../src/server.js";
import { BrokerStore } from "../src/store.js";
import { BROKER, FakeChain, GRANTEE, GRANTOR, grant, KEY, NOW } from "./helpers.js";

const CIRCLE = "x207-circle.near";

/** A facilitator that answers `/supported`, `/verify` and `/settle`, and remembers what it was asked. */
function facilitator(verdict: { isValid: boolean; invalidReason?: string } = { isValid: true }) {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (path === "/supported") return reply({ kinds: [{ scheme: "batch-settlement", network: "x207:agents-main", extra: { circleContract: CIRCLE, epoch: 42 } }] });
    if (path === "/verify") return reply(verdict);
    if (path === "/settle") return reply({ success: true, transaction: "", network: "x207:agents-main", payer: GRANTEE });
    void init;
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

function setup(verdict?: { isValid: boolean; invalidReason?: string }) {
  const chain = new FakeChain();
  const store = new BrokerStore(":memory:");
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => chain.now });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB } });
  const f = facilitator(verdict);
  const handler = createBrokerHandler({ dispatcher, classB, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", brokerAccount: BROKER, fetch: f.fetchFn });
  return { chain, store, handler, f };
}

const leaseUrl = (id: number) => `http://broker.test/grants/${id}/lease`;
const paid = (url: string, requirements: unknown, payer = GRANTEE) =>
  new Request(url, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, accepted: requirements, payload: { voucher: { payer }, signature: "ed25519:x" } })).toString("base64") } });

async function firstRequirements(handler: ReturnType<typeof setup>["handler"], id = 1) {
  const response = await handler(new Request(leaseUrl(id)));
  const body = (await response.json()) as { accepts: Array<{ scheme: string; payTo: string; amount: string; extra: Record<string, unknown> }> };
  return { response, body, x207: body.accepts.find((a) => a.scheme === "batch-settlement")! };
}

describe("BK-002 and BK-005 the 402 of the lease endpoint", () => {
  it("TC-BK-002-01 402 pays the grantor, names the grant, and its amount is the price of one day from the grant", async () => {
    const { chain, handler } = setup();
    chain.grants.set(1, grant());
    const { response, x207 } = await firstRequirements(handler);
    expect(response.status).toBe(402);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(x207).toMatchObject({ payTo: GRANTOR, amount: "250000", extra: { grantId: 1, circleContract: CIRCLE } });
    expect(validatePaymentRequirements(x207).ok).toBe(true);
    expect(creditPrice("250000")).toBe("0.250000");
    expect(chain.calls.filter((c) => c.startsWith("addKey"))).toEqual([]);
  });

  it("TC-BK-005-01 a dearer grant gives a dearer 402, and no transaction of the broker is made for a 402", async () => {
    const { chain, handler } = setup();
    chain.grants.set(2, grant({ grant_id: 2, unit_price: "1234567" }));
    const { x207 } = await firstRequirements(handler, 2);
    expect(x207.amount).toBe("1234567");
    expect(chain.calls.filter((c) => c.startsWith("revoke") || c.startsWith("addKey") || c.startsWith("deleteKey"))).toEqual([]);
  });

  it("TC-BK-002-02 nothing is charged for a grant that does not exist, is not active or was revoked", async () => {
    const { chain, handler, f } = setup();
    chain.grants.set(2, grant({ grant_id: 2, status: "offered", grantee: null }));
    chain.grants.set(3, grant({ grant_id: 3, status: "revoked" }));
    const cases: Array<[number, number, string]> = [[9, 404, "grant_not_found"], [2, 403, "grant_not_active"], [3, 403, "grant_revoked"]];
    for (const [id, status, code] of cases) {
      const r = await handler(new Request(leaseUrl(id)));
      expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([status, code]);
    }
    expect(f.seen.filter((p) => p === "/verify" || p === "/settle")).toEqual([]);
  });
});

describe("BK-006 class B lease", () => {
  it("TC-BK-006-01 a paid request adds the key of the lessee with the grant scope, then settles", async () => {
    const { chain, store, handler, f } = setup();
    chain.grants.set(1, grant());
    const { x207 } = await firstRequirements(handler);
    const response = await handler(paid(leaseUrl(1), x207));
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ grantId: 1, publicKey: KEY, receiverId: "api.x207-circle.near", methodNames: ["get_data"] });
    expect(body.paidUntil).toBe(new Date(NOW + DAY_MS).toISOString());
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(chain.keys.has(KEY)).toBe(true);
    expect(store.lease(1)).toMatchObject({ keyAdded: true, paidUntilMs: NOW + DAY_MS });
    expect(f.seen.indexOf("/verify")).toBeLessThan(f.seen.indexOf("/settle"));
    // the answer carries no secret of the lease account
    expect(JSON.stringify(body)).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/);
  });

  it("TC-BK-006-02 the second payment extends the rent and does not add the key again", async () => {
    const { chain, store, handler } = setup();
    chain.grants.set(1, grant());
    const { x207 } = await firstRequirements(handler);
    await handler(paid(leaseUrl(1), x207));
    const second = await handler(paid(leaseUrl(1), x207));
    expect(second.status).toBe(200);
    expect(store.lease(1)!.paidUntilMs).toBe(NOW + 2 * DAY_MS);
    expect(chain.calls.filter((c) => c.startsWith("addKey"))).toHaveLength(1);
  });

  it("TC-BK-006-03 a payer that is not the lessee gets 403 and no key; a facilitator that refuses the voucher gets 402 and no key", async () => {
    const { chain, handler } = setup();
    chain.grants.set(1, grant());
    const { x207 } = await firstRequirements(handler);
    const stranger = await handler(paid(leaseUrl(1), x207, "gpu.x207-circle.near"));
    expect([stranger.status, ((await stranger.json()) as { error: string }).error]).toEqual([403, "payer_not_grantee"]);
    expect(chain.keys.size).toBe(0);

    const refused = setup({ isValid: false, invalidReason: "insufficient_credit" });
    refused.chain.grants.set(1, grant());
    const { x207: req } = await firstRequirements(refused.handler);
    const response = await refused.handler(paid(leaseUrl(1), req));
    expect(response.status).toBe(402);
    expect(refused.chain.keys.size).toBe(0);
  });

  it("TC-BK-006-04 a key that cannot be added gives 502 and the voucher is not settled", async () => {
    const { chain, handler, f } = setup();
    chain.grants.set(1, grant());
    chain.addLeaseKey = async () => {
      throw new Error("node down");
    };
    const { x207 } = await firstRequirements(handler);
    const response = await handler(paid(leaseUrl(1), x207));
    expect(response.status).toBe(502);
    expect(f.seen).not.toContain("/settle");
  });
});
