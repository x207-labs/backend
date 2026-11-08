import { afterEach, describe, expect, it } from "vitest";
import { createApiServer, apiOptionsFromEnv, corsHeaders, metricsTokenFromEnv, readOnlyFromEnv } from "../../src/api/server.js";
import { listen } from "../helpers/d9-fixtures.js";
import Database from "better-sqlite3";

// BE-089: the public read API serves GET only and answers CORS for the listed origins only.
describe("BE-089 read-only mode and CORS allow-list", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });
  const start = async (options: Record<string, unknown>) => {
    const db = new Database(":memory:");
    const srv = await listen({ db, ...options });
    closers.push(async () => { await srv.close(); db.close(); });
    return srv;
  };

  it("TC-BE-089-01 in read-only mode a POST is not served and the preflight says GET, OPTIONS; healthz still answers", async () => {
    const srv = await start({ readOnly: true });
    const post = await fetch(`${srv.url}/x207/circles/agents-main/listings`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(404);
    const pre = await fetch(`${srv.url}/x207/circles/agents-main/listings`, { method: "OPTIONS" });
    expect(pre.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect((await fetch(`${srv.url}/healthz`)).status).toBeLessThan(600);
    const open = await start({});
    expect((await fetch(`${open.url}/x207/circles/agents-main/listings`, { method: "OPTIONS" })).headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  });

  it("TC-BE-089-02 with a list of origins only those are allowed, exactly; any other origin gets no allow header; without a list it is *", async () => {
    const dash = "https://x207-dashboard.vercel.app";
    const srv = await start({ corsOrigins: [dash] });
    const ok = await fetch(`${srv.url}/healthz`, { headers: { origin: dash } });
    expect([ok.headers.get("access-control-allow-origin"), ok.headers.get("vary")]).toEqual([dash, "Origin"]);
    for (const origin of ["https://evil.vercel.app", "https://x207-dashboard.vercel.app.evil.com", "http://x207-dashboard.vercel.app"]) {
      const other = await fetch(`${srv.url}/healthz`, { headers: { origin } });
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await fetch(`${srv.url}/healthz`)).headers.get("access-control-allow-origin")).toBeNull(); // no Origin header: nothing to allow
    const pre = await fetch(`${srv.url}/healthz`, { method: "OPTIONS", headers: { origin: dash } });
    expect(pre.headers.get("access-control-allow-origin")).toBe(dash);
    expect(corsHeaders(undefined, undefined)).toEqual({ "Access-Control-Allow-Origin": "*" });
  });

  it("TC-BE-089-03 the environment: X207_READ_ONLY=1 and X207_CORS_ORIGINS; a wildcard or a path is refused at start", () => {
    expect(apiOptionsFromEnv({ X207_READ_ONLY: "1", X207_CORS_ORIGINS: "https://a.example, https://b.example:8443" })).toMatchObject({ readOnly: true, corsOrigins: ["https://a.example", "https://b.example:8443"] });
    expect(apiOptionsFromEnv({ X207_READ_ONLY: "0" })).not.toHaveProperty("readOnly");
    for (const bad of ["*", "https://*.vercel.app", "https://a.example/path", "a.example"]) expect(() => apiOptionsFromEnv({ X207_CORS_ORIGINS: bad })).toThrow(/is not an origin/);
  });

  it("TC-BE-108-01 /metrics is closed without METRICS_TOKEN (random token, warning); open only with X207_METRICS_OPEN=1; the given token is used as is", () => {
    expect(metricsTokenFromEnv({ METRICS_TOKEN: "t0" })).toEqual({ metricsToken: "t0" });
    expect(metricsTokenFromEnv({ X207_METRICS_OPEN: "1" })).toEqual({});
    const closed = metricsTokenFromEnv({});
    expect(closed.metricsToken).toMatch(/^[0-9a-f]{64}$/);
    expect(closed.warn).toContain("/metrics is closed");
    expect(metricsTokenFromEnv({ X207_METRICS_OPEN: "true" }).metricsToken).toMatch(/^[0-9a-f]{64}$/);
    expect(metricsTokenFromEnv({}).metricsToken).not.toBe(closed.metricsToken);
  });

  it("TC-BE-104-01 read-only is the default: only 0 or false open the write routes; unknown values stay read-only with a warning", () => {
    expect(readOnlyFromEnv({})).toEqual({ readOnly: true });
    expect(apiOptionsFromEnv({})).toMatchObject({ readOnly: true });
    for (const on of ["1", "true", "TRUE", " 1 "]) expect(readOnlyFromEnv({ X207_READ_ONLY: on })).toEqual({ readOnly: true });
    for (const off of ["0", "false", "False"]) expect(readOnlyFromEnv({ X207_READ_ONLY: off })).toEqual({ readOnly: false });
    for (const odd of ["yes", "off", "2"]) expect(readOnlyFromEnv({ X207_READ_ONLY: odd })).toMatchObject({ readOnly: true, warn: expect.stringContaining("staying read-only") });
  });
});
