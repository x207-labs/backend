import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectRoutes } from "../../src/api/server.js";
import { openDatabase } from "../../src/db/index.js";
import { marketplaceRoutes } from "../../src/marketplace/index.js";
import { faucetRoutes, FAUCET_DEFAULTS } from "../../src/faucet/faucet.js";
import { APPRAISER_DEFAULTS, DEFAULT_APPRAISER_MODEL, appraiserRoutes } from "../../src/appraiser/appraiser.js";

const FILE = new URL("../../docs/openapi.json", import.meta.url);
const doc = JSON.parse(readFileSync(FILE, "utf8")) as any;
const OPS = ["get", "post"] as const;
const flatten = (paths: Record<string, any>): Array<{ method: string; path: string; op: any }> =>
  Object.entries(paths).flatMap(([path, item]) => OPS.filter((m) => item[m]).map((m) => ({ method: m.toUpperCase(), path, op: item[m] })));
/** The backend's operations are in `paths`; the broker's, another server with some of the same names, in `x-broker-paths`. */
const operations = (): Array<{ method: string; path: string; op: any }> => [...flatten(doc.paths), ...flatten(doc["x-broker-paths"])];

describe("BE-068 the OpenAPI document and the router say the same", () => {
  const db = openDatabase(":memory:");
  const routes = collectRoutes({
    settlement: { client: {} as never, accountExists: async () => true },
    daoView: async () => null,
    extraRoutes: [
      ...marketplaceRoutes(db),
      ...faucetRoutes(db, {} as never, { ...FAUCET_DEFAULTS, usdtContract: "usdt.example.testnet" }),
      ...appraiserRoutes(db, { ...APPRAISER_DEFAULTS, cloud: undefined, model: DEFAULT_APPRAISER_MODEL }),
    ],
  });
  const mine = flatten(doc.paths);

  it("TC-BE-068-01 every route of the router is in the document, and every route of the document is in the router", () => {
    const inRouter = routes.map((r) => `${r.method} ${r.pattern}`).sort();
    const inDoc = mine.map((o) => `${o.method} ${o.path}`).sort();
    expect(inRouter.filter((r) => !inDoc.includes(r)), "in the router, not in docs/openapi.json (run: node scripts/build-openapi.mjs)").toEqual([]);
    expect(inDoc.filter((r) => !inRouter.includes(r)), "in docs/openapi.json, not in the router").toEqual([]);
    expect(new Set(inRouter).size).toBe(inRouter.length); // two routes with one key would hide each other
  });

  it("TC-BE-068-02 docs/openapi.json is what scripts/build-openapi.mjs makes from the sources now", async () => {
    const mod = (await import(String("../../scripts/build-openapi.mjs"))) as { buildOpenApi: () => unknown };
    expect(JSON.parse(JSON.stringify(mod.buildOpenApi())), "rebuild: node scripts/build-openapi.mjs").toEqual(doc);
  });

  it("TC-BE-068-03 the document is well formed: 3.1, unique operation ids, every path parameter declared, every $ref resolves", () => {
    expect(doc.openapi).toBe("3.1.0");
    const ids = operations().map((o) => o.op.operationId);
    expect(new Set(ids).size, "operationId must be unique").toBe(ids.length);
    for (const { method, path, op } of operations()) {
      const declared = new Set((op.parameters as Array<{ name: string; in: string }>).filter((p) => p.in === "path").map((p) => p.name));
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
      expect([...declared].sort(), `${method} ${path}`).toEqual([...inPath].sort());
      expect(Object.keys(op.responses).length, `${method} ${path}`).toBeGreaterThanOrEqual(2);
    }
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1] as string);
    for (const r of refs) expect(Object.keys(doc.components.schemas), r).toContain(r);
  });

  it("TC-BE-068-04 the limits of BE-066 are in the document: every route can answer 429 rate_limited with Retry-After, every POST has a body and 413, the three that hold open objects have open_limit_reached", () => {
    for (const { method, path, op } of operations()) {
      expect(op.responses["429"]?.["x-error-codes"], `${method} ${path}`).toContain("rate_limited");
      if (op["x-broker"] !== true) expect(op.responses["429"].headers["Retry-After"], `${method} ${path}`).toBeDefined();
      if (method === "POST" && op["x-broker"] !== true) {
        expect(op.requestBody, `${method} ${path}`).toBeDefined();
        expect(op.responses["413"]?.["x-error-codes"], `${method} ${path}`).toEqual(["payload_too_large"]);
      }
    }
    const codes = (m: string, p: string): string[] => doc.paths[p][m].responses["409"]["x-error-codes"];
    for (const p of ["/x207/circles/{circle}/orders", "/x207/circles/{circle}/invoices", "/x207/circles/{circle}/listings/{hash}/purchases"]) expect(codes("post", p), p).toContain("open_limit_reached");
  });

  it("TC-BE-068-05 the error codes of the backend in the document are all codes the API has (ApiErrorCode)", () => {
    const source = readFileSync(new URL("../../src/api/errors.ts", import.meta.url), "utf8");
    const known = new Set([...source.slice(0, source.indexOf("export class ApiError")).matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]));
    const used = new Set<string>();
    for (const { op } of mine) for (const r of Object.values(op.responses as Record<string, any>)) for (const c of r["x-error-codes"] ?? []) used.add(c as string);
    expect([...used].filter((c) => !known.has(c)), "codes in the document that ApiErrorCode does not have").toEqual([]);
  });
});
