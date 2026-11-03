import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardedGet, isPublicIp, type Transport } from "../src/provider/ssrf.js";

interface Cases {
  publicIps: string[];
  nonPublicIps: string[];
  urls: Array<{ url: string; resolve: string[]; result: "ok" | "forbidden"; why: string; resolvedHost?: string }>;
}
// The same table as backend/test/marketplace/ssrf-shared.test.ts: this file is a copy of the guard of the backend (src/marketplace/ssrf.ts); if one is changed and not the other, one suite fails.
const cases = JSON.parse(readFileSync(new URL("../../test/fixtures/ssrf-cases.json", import.meta.url), "utf8")) as Cases;

describe("BE-057 SSRF guard of the broker: the table shared with the backend", () => {
  it("TC-BE-057-T1 addresses: public and not public", () => {
    for (const ip of cases.publicIps) expect(isPublicIp(ip), ip).toBe(true);
    for (const ip of cases.nonPublicIps) expect(isPublicIp(ip), JSON.stringify(ip)).toBe(false);
  });

  it("TC-BE-057-T2 addresses and names: what is fetched and what is refused", async () => {
    const ok: Transport = async () => ({ status: 200, body: Buffer.from("x"), truncated: false });
    for (const c of cases.urls) {
      const asked: string[] = [];
      const result = await guardedGet(c.url, { resolver: async (h) => (asked.push(h), c.resolve), transport: ok }).then(() => "ok", () => "forbidden");
      expect(result, `${c.url} (${c.why})`).toBe(c.result);
      if (c.resolvedHost !== undefined) expect(asked, c.url).toEqual([c.resolvedHost]);
    }
  });
});
