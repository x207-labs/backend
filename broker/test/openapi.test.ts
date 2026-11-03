import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACCESS_PATH } from "../src/provider/routes.js";
import { matchProxy } from "../src/proxy/handler.js";

const doc = JSON.parse(readFileSync(new URL("../../docs/openapi.json", import.meta.url), "utf8")) as any;
const brokerOps = Object.entries(doc.paths as Record<string, any>).flatMap(([path, item]) => Object.entries(item as Record<string, any>).filter(([, op]) => op["x-broker"] === true).map(([method]) => `${method.toUpperCase()} ${path}`));

describe("BE-068 the routes of the broker in docs/openapi.json", () => {
  it("TC-BE-068-06 the document lists the routes that the broker answers, no other, and the path patterns of the broker are the ones it knows", () => {
    expect(brokerOps.sort()).toEqual([
      "GET /grants/{grantId}/access", "GET /grants/{grantId}/access/challenge", "GET /grants/{grantId}/lease", "GET /health",
      "POST /grants/{grantId}/access", "POST /grants/{grantId}/access/stop", "POST /grants/{grantId}/proxy/{path}",
    ]);
    // each listed path is matched by the pattern of the broker
    for (const tail of ["/access", "/access/challenge", "/access/stop"]) expect(ACCESS_PATH.test(`/grants/7${tail}`), tail).toBe(true);
    expect(matchProxy(new URL("http://b/grants/7/proxy/v1/echo"))).toMatchObject({ grantId: 7, path: "/v1/echo" });
    // a new path pattern in the server of the broker must come with a line in the document: the source has exactly these routing markers
    const files = ["server.ts", "provider/routes.ts", "proxy/handler.ts"].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).join("\n");
    const markers = [...files.matchAll(/const (\w+_PATH) = \//g)].map((m) => m[1]).sort();
    expect(markers, "a new routing pattern: add its routes to BROKER_ROUTES in scripts/build-openapi.mjs and to this list").toEqual(["ACCESS_PATH", "LEASE_PATH", "PROXY_PATH"]);
    expect([...files.matchAll(/url\.pathname === "([^"]+)"/g)].map((m) => m[1])).toEqual(["/health"]);
    expect(readdirSync(new URL("../src", import.meta.url)).length).toBeGreaterThan(0);
  });

  it("TC-BE-068-07 the documented error codes of the broker are the ones its routes send", () => {
    const sent = readFileSync(new URL("../src/provider/routes.ts", import.meta.url), "utf8") + readFileSync(new URL("../src/server.ts", import.meta.url), "utf8") + readFileSync(new URL("../src/proxy/handler.ts", import.meta.url), "utf8");
    const access = doc.paths["/grants/{grantId}/access"].post.responses;
    for (const code of access["403"]["x-error-codes"] as string[]) expect(sent, code).toContain(code);
    for (const code of ["payload_too_large", "rate_limited", "access_not_found", "not_grantee", "grant_quota_exceeded", "grant_scope_denied"]) expect(sent, code).toContain(code);
  });
});
