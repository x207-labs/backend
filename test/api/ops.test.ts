import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger, redact, redactString } from "../../src/log.js";
import type { Route } from "../../src/api/router.js";
import { marketplaceRoutes } from "../../src/marketplace/index.js";
import { acct, CONTRACT, listen, seedCircle, seedMember, type TestServer } from "../helpers/d9-fixtures.js";

const NOW = 60_000;
const BASE = "/x207/circles/agents-main";
// secrets as a fixture: none of them may reach a log line or a metric
const SECRETS = {
  bearer: "sk-live-0123456789abcdefSECRETKEYVALUE",
  gh: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  signature: "ed25519:5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4UKZvpe6E3AgLr8Z4Dk9QJw5L3vXj2m9nE7bTqY6hUc1zW4fRaS",
  token: "tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
};

describe("BE-071 health, metrics and structured logs", () => {
  let db: Database.Database;
  let srv: TestServer;
  afterEach(async () => {
    await srv?.close();
    db?.close();
  });
  async function start(opts: Record<string, unknown> = {}, seed = true, extraRoutes: Route[] = []) {
    db = new Database(":memory:");
    if (seed) {
      seedCircle(db);
      seedMember(db, { name: "andi" });
    }
    srv = await listen({ db, now: () => NOW, extraRoutes: [...(seed ? marketplaceRoutes(db) : []), ...extraRoutes], ...opts } as never);
  }
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(srv.url + path, { headers });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), headers: r.headers };
  };

  it("TC-BE-071-01 /healthz: ok with the database, the indexer lag and the RPC; degraded (still 200) when the indexer is behind, stuck, or the RPC fails; down (503) with no database cursor", async () => {
    await start({ rpcProbe: async () => ({ endpoint: "https://rpc.test" }) });
    const ok = await get("/healthz");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ status: "ok", db: { ok: true }, indexer: { lagBlocks: 0, lastBlockHeight: 171234567, stale: false }, rpc: { status: "ok", endpoint: "https://rpc.test" }, problems: [] });
    await srv.close();
    db.close();

    await start({ rpcProbe: async () => { throw new Error("connect ECONNREFUSED"); } });
    db.prepare("UPDATE indexer_cursor SET lag_blocks = 500, updated_at = 1").run();
    const bad = await get("/healthz");
    expect(bad.status).toBe(200);
    expect(bad.json.status).toBe("degraded");
    expect(bad.json.rpc).toMatchObject({ status: "failing" });
    expect(bad.json.problems.join(" ")).toMatch(/500 blocks behind/);
    await srv.close();
    db.close();

    await start({}, false); // a database without a cursor
    db.exec("CREATE TABLE IF NOT EXISTS indexer_cursor (name TEXT, last_block_height INTEGER, head_block_height INTEGER, lag_blocks INTEGER, updated_at INTEGER)");
    const down = await get("/healthz");
    expect([down.status, down.json.status, down.json.indexer]).toEqual([503, "down", null]);
    // the old route is unchanged
    expect((await get("/x207/health")).status).toBe(503);
  });

  it("TC-BE-071-02 /healthz is down when the database cannot be read", async () => {
    await start();
    db.close();
    const r = await get("/healthz");
    expect([r.status, r.json.status, r.json.db.ok]).toEqual([503, "down", false]);
    db = new Database(":memory:"); // for the afterEach
  });

  it("TC-BE-071-03 /metrics: the counters rise after requests, by route pattern and status; unknown paths are one series; 429 is counted by scope; the indexer lag is there; no path, hash or account becomes a label", async () => {
    await start({ abuse: { writeIpPerMinute: 2 } });
    const before = (await get("/metrics")).text;
    expect(before).not.toContain('route="/metrics"'); // a request is counted when it is over, so the first scrape does not see itself
    for (let i = 0; i < 3; i++) await get(`${BASE}/members/${acct("andi")}`);
    await get(`${BASE}/members/nobody.near`);
    await get("/x207/nothing/at/all/abc123");
    await get("/x207/also/nothing/def456");
    for (let i = 0; i < 3; i++) await fetch(`${srv.url}${BASE}/intents`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const after = (await get("/metrics")).text;
    expect(after).toContain('x207_http_requests_total{method="GET",route="/x207/circles/{circle}/members/{account}",code="200"} 3');
    expect(after).toContain('x207_http_requests_total{method="GET",route="/x207/circles/{circle}/members/{account}",code="404"} 1');
    expect(after).toContain('x207_http_requests_total{method="GET",route="unmatched",code="404"} 2');
    expect(after).toContain('x207_http_requests_total{method="POST",route="/x207/circles/{circle}/intents",code="400"} 2');
    expect(after).toContain('x207_http_requests_total{method="POST",route="/x207/circles/{circle}/intents",code="429"} 1');
    expect(after).toContain('x207_rate_limited_total{scope="ip_write"} 1');
    expect(after).toMatch(/x207_indexer_lag_blocks\{contract="[^"]+"\} 0/);
    expect(after).toContain("x207_db_up 1");
    expect(after).toMatch(/# TYPE x207_http_requests_total counter/);
    for (const leak of [acct("andi"), "nobody.near", "abc123", "def456"]) expect(after, leak).not.toContain(leak);
    // a counter only goes up
    const again = (await get("/metrics")).text;
    expect(after).toContain('route="/metrics",code="200"} 1');
    expect(again).toContain('route="/metrics",code="200"} 2');
  });

  it("TC-BE-071-04 /metrics needs the bearer token when one is set", async () => {
    await start({ metricsToken: "metrics-secret-token" });
    expect((await get("/metrics")).status).toBe(401);
    expect((await get("/metrics", { authorization: "Bearer wrong" })).status).toBe(401);
    const ok = await get("/metrics", { authorization: "Bearer metrics-secret-token" });
    expect([ok.status, ok.headers.get("content-type")]).toEqual([200, "text/plain; version=0.0.4; charset=utf-8"]);
    expect(ok.text).not.toContain("metrics-secret-token");
    expect((await get("/healthz")).status).toBe(200); // the probe stays open
  });

  it("TC-BE-071-05 the logs are JSON lines, one per request, with the route pattern; nothing of the fixture secrets reaches them, not from the headers, the query, the path, the body or an error", async () => {
    const lines: string[] = [];
    const boom: Route = { method: "GET", pattern: "/x207/boom", circleScoped: false, handler: () => { throw new Error(`upstream said Bearer ${SECRETS.bearer} and token=${SECRETS.token} for ${SECRETS.signature}`); } };
    await start({ logger: createLogger({ write: (l) => lines.push(l), now: () => NOW }) }, true, [boom]);
    await get(`${BASE}/members/${acct("andi")}?token=${SECRETS.token}&api_key=${SECRETS.gh}`, { authorization: `Bearer ${SECRETS.bearer}`, cookie: `session=${SECRETS.jwt}` });
    await get(`/x207/leak/${SECRETS.gh}/${SECRETS.signature}`);
    await fetch(`${srv.url}${BASE}/intents`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRETS.bearer}` }, body: JSON.stringify({ signature: SECRETS.signature, token: SECRETS.token, intent: { jwt: SECRETS.jwt } }) });
    await get("/x207/boom");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const p of parsed) expect(p).toMatchObject({ ts: expect.stringMatching(/^1970-01-01T00:01:00/), level: expect.stringMatching(/^(info|error|warn)$/), msg: expect.any(String) });
    expect(parsed[0]).toMatchObject({ msg: "request", method: "GET", route: "/x207/circles/{circle}/members/{account}", status: 200 });
    expect(parsed.find((p) => p.msg === "request" && p.route === "unmatched")).toBeDefined();
    const error = parsed.find((p) => p.level === "error")!;
    expect(error).toMatchObject({ msg: "internal error", route: "/x207/boom", status: 500 });
    const all = lines.join("\n");
    for (const [name, secret] of Object.entries(SECRETS)) expect(all, name).not.toContain(secret);
    // the path and the query are not in a line at all
    expect(all).not.toContain("members/" + acct("andi"));
  });

  it("TC-BE-071-06 redaction: a field named like a secret is replaced whole, a secret-shaped string is replaced inside any text, a public key is kept, ts and level cannot be overwritten", () => {
    const out = redact({
      apiKey: "x", token: "y", Authorization: "Bearer abc", voucher_signature: "z", password: "p", pubkey_voucher: "ed25519:DEmhkZ1kKY7q7Rmk2C8CeLNwo3KgF8TDQ7sPnahnXVeH", note: `see ${SECRETS.signature} and ${SECRETS.gh}`,
      nested: { secretValue: 1, list: [SECRETS.jwt, { cookie: "c" }] }, big: 12n, err: new Error(`failed with Bearer ${SECRETS.bearer}`),
    }) as Record<string, any>;
    expect([out.apiKey, out.token, out.Authorization, out.voucher_signature, out.password, out.nested.secretValue, out.nested.list[1].cookie]).toEqual(Array(7).fill("[redacted]"));
    expect(out.pubkey_voucher).toBe("ed25519:DEmhkZ1kKY7q7Rmk2C8CeLNwo3KgF8TDQ7sPnahnXVeH"); // a public key under a public name is kept
    expect((redact({ other: "ed25519:DEmhkZ1kKY7q7Rmk2C8CeLNwo3KgF8TDQ7sPnahnXVeH" }) as { other: string }).other).toBe("ed25519:[redacted]"); // under any other name it looks like a secret and is hidden
    expect(out.note).toBe("see ed25519:[redacted] and [redacted]");
    expect(out.nested.list[0]).toBe("[redacted]");
    expect(out.big).toBe("12");
    expect(out.err.message).toBe("failed with Bearer [redacted]");
    expect(redactString("GET /x?token=abc123&x=1 password=hunter2")).toBe("GET /x?token=[redacted]&x=1 password=[redacted]");
    const lines: string[] = [];
    createLogger({ write: (l) => lines.push(l), now: () => 0 }).warn("hello", { ts: "tampered", level: "debug", msg: "tampered" });
    expect(JSON.parse(lines[0]!)).toMatchObject({ ts: "1970-01-01T00:00:00.000Z", level: "warn", msg: "hello" });
    createLogger({ write: (l) => lines.push(l), level: "warn" }).info("skipped");
    expect(lines).toHaveLength(1);
  });
});
