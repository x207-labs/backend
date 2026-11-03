import { describe, expect, it } from "vitest";
import { Dispatcher } from "../src/dispatcher.js";
import { ClassBAdapter } from "../src/keys/class-b.js";
import { MockProviderAdapter, ProviderAccessManager } from "../src/provider/index.js";
import { createBrokerHandler } from "../src/server.js";
import { BrokerStore } from "../src/store.js";
import { BROKER, FakeChain } from "./helpers.js";

const NOW = Date.parse("2026-11-04T10:00:00Z");

function setup(o: { limits?: Record<string, number>; token?: string } = {}) {
  const chain = new FakeChain();
  const store = new BrokerStore(":memory:");
  const classB = new ClassBAdapter({ chain, store, viewAccessKey: async () => null, now: () => NOW });
  const dispatcher = new Dispatcher({ chain, adapters: { B: classB } });
  const manager = new ProviderAccessManager({ store, now: () => NOW });
  manager.register(new MockProviderAdapter({ now: () => NOW }));
  const handler = createBrokerHandler({
    dispatcher, classB, facilitatorUrl: "http://facilitator.test", circleId: "agents-main", brokerAccount: BROKER, store, now: () => NOW, ...(o.token ? { metricsToken: o.token } : {}),
    provider: { manager, contractId: "x207-circle.near", now: () => NOW, voucherKeyOf: async () => null, limits: o.limits ?? {} },
  });
  return { chain, store, manager, handler };
}
const ask = (h: ReturnType<typeof setup>["handler"], path: string, headers: Record<string, string> = {}, method = "GET") => h(new Request(`http://broker.test${path}`, { method, headers }));

describe("BE-071 health and metrics of the broker", () => {
  it("TC-BE-071-10 /metrics counts the requests by route name and status, not by path; 429 is counted; no grant id is a label", async () => {
    const t = setup({ limits: { grantPerMinute: 1, ipPerMinute: 0 } });
    await ask(t.handler, "/health");
    await ask(t.handler, "/grants/7/lease");
    await ask(t.handler, "/grants/8/lease");
    await ask(t.handler, "/nothing/here/12345");
    await ask(t.handler, "/grants/9/access/challenge");
    await ask(t.handler, "/grants/9/access/challenge"); // over the rate of the grant
    const text = await (await ask(t.handler, "/metrics")).text();
    expect(text).toContain('x207_broker_http_requests_total{method="GET",route="health",code="200"} 1');
    expect(text).toMatch(/x207_broker_http_requests_total\{method="GET",route="lease",code="\d+"\} 2/);
    expect(text).toContain('x207_broker_http_requests_total{method="GET",route="unmatched",code="404"} 1');
    expect(text).toContain('x207_broker_http_requests_total{method="GET",route="access_challenge",code="429"} 1');
    expect(text).toContain('x207_broker_rate_limited_total{route="access_challenge"} 1');
    expect(text).toContain("x207_broker_db_up 1");
    for (const leak of ["/grants/7", "12345", 'grant="']) expect(text, leak).not.toContain(leak);
    expect(await (await ask(t.handler, "/metrics")).text()).toContain('route="metrics",code="200"} 1');
  });

  it("TC-BE-071-11 the revoke queues: a class B lease past its paid day and a provider access whose revoke failed show in the gauges, and /healthz is degraded until they are gone", async () => {
    const t = setup();
    expect((await (await ask(t.handler, "/healthz")).json() as any).status).toBe("ok");
    t.store.save({ grantId: 1, publicKey: "ed25519:x", paidUntilMs: NOW - 1000, keyAdded: true, closed: false });
    t.store.save({ grantId: 2, publicKey: "ed25519:y", paidUntilMs: NOW + 86_400_000, keyAdded: true, closed: false });
    t.store.db.prepare("INSERT INTO provider_access (grant_id, provider, grantee_ref, handle, status, paid_until_ms, attempts, next_retry_ms, last_error, reason, proof) VALUES (3, 'mock', 'a', 'h', 'revoke_pending', ?, 2, ?, 'HTTP 503', 'paid_until', NULL)").run(NOW - 5000, NOW - 1000);
    t.store.db.prepare("INSERT INTO provider_access (grant_id, provider, grantee_ref, handle, status, paid_until_ms, attempts, next_retry_ms, last_error, reason, proof) VALUES (4, 'mock', 'b', 'h2', 'active', ?, 0, NULL, NULL, NULL, NULL)").run(NOW + 1000);
    const text = await (await ask(t.handler, "/metrics")).text();
    expect(text).toContain("x207_broker_leases_open 2");
    expect(text).toContain('x207_broker_revoke_queue{kind="lease"} 1');
    expect(text).toContain('x207_broker_revoke_queue{kind="provider"} 1');
    expect(text).toContain('x207_broker_revoke_queue{kind="provider_due"} 1');
    expect(text).toContain("x207_broker_provider_access_active 1");
    const health = await ask(t.handler, "/healthz");
    const body = (await health.json()) as any;
    expect([health.status, body.status, body.revokeQueue]).toEqual([200, "degraded", { leasesOverdue: 1, providerRevokePending: 1 }]);
    expect(body.problems.join(" ")).toMatch(/sewa kelas B/);
    // the secrets of a provider row (the error text of the provider) are in no metric
    expect(text).not.toContain("HTTP 503");
  });

  it("TC-BE-071-12 /healthz is down (503) when the database does not answer; /metrics needs the bearer token when one is set; /health stays", async () => {
    const t = setup({ token: "broker-metrics-token" });
    expect((await ask(t.handler, "/metrics")).status).toBe(401);
    expect((await ask(t.handler, "/metrics", { authorization: "Bearer broker-metrics-token" })).status).toBe(200);
    expect((await ask(t.handler, "/health")).status).toBe(200);
    t.store.db.close();
    const down = await ask(t.handler, "/healthz");
    expect([down.status, ((await down.json()) as any).status]).toEqual([503, "down"]);
  });
});

describe("BE-071 the lines of the broker log", () => {
  it("TC-BE-071-13 a line of the broker becomes a JSON object and the shapes of secrets are taken out of it", async () => {
    const { jsonLine } = await import("../src/log.js");
    const lines: string[] = [];
    jsonLine((l) => lines.push(l), () => 0)("provider access revoke_pending grant=3 attempt=2: HTTP 503: Bearer sk-live-0123456789abcdefSECRET ed25519:5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4UKZvpe6E3AgLr8Z4Dk9QJw5L3vXj2m9nE7bTqY6hUc1zW4fRaS ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 token=abc123def");
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({ ts: "1970-01-01T00:00:00.000Z", level: "info" });
    for (const secret of ["sk-live-0123456789abcdefSECRET", "5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4UKZvpe6E3AgLr8Z4Dk9QJw5L3vXj2m9nE7bTqY6hUc1zW4fRaS", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "abc123def"]) expect(lines[0], secret).not.toContain(secret);
    expect(parsed.msg).toContain("grant=3 attempt=2");
  });
});
