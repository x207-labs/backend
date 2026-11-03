import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardedGet, isPublicIp, type Transport } from "../../src/marketplace/ssrf.js";

interface Cases {
  publicIps: string[];
  nonPublicIps: string[];
  urls: Array<{ url: string; resolve: string[]; result: "ok" | "forbidden"; why: string; resolvedHost?: string }>;
}
const cases = JSON.parse(readFileSync(new URL("../fixtures/ssrf-cases.json", import.meta.url), "utf8")) as Cases;

// The broker has a copy of this guard (broker/src/provider/ssrf.ts) and runs the same table in broker/test/ssrf-shared.test.ts.
describe("BE-054 SSRF guard: the table shared with the broker", () => {
  it("TC-BE-054-T1 addresses: public and not public", () => {
    for (const ip of cases.publicIps) expect(isPublicIp(ip), ip).toBe(true);
    for (const ip of cases.nonPublicIps) expect(isPublicIp(ip), JSON.stringify(ip)).toBe(false);
  });

  it("TC-BE-054-T2 addresses and names: what is fetched and what is refused", async () => {
    const ok: Transport = async () => ({ status: 200, body: Buffer.from("x"), truncated: false });
    for (const c of cases.urls) {
      const asked: string[] = [];
      const result = await guardedGet(c.url, { resolver: async (h) => (asked.push(h), c.resolve), transport: ok }).then(() => "ok", () => "forbidden");
      expect(result, `${c.url} (${c.why})`).toBe(c.result);
      if (c.resolvedHost !== undefined) expect(asked, c.url).toEqual([c.resolvedHost]);
    }
  });
});
