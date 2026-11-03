import { describe, expect, it } from "vitest";
import { activeGrantIdsOf } from "../src/grants-api.js";

describe("activeGrantIdsOf", () => {
  it("follows the cursor and asks for the active grants of the grantee only", async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      const second = url.includes("cursor=c2");
      return new Response(JSON.stringify({ items: second ? [{ grantId: 5 }] : [{ grantId: 2 }, { grantId: 3 }], nextCursor: second ? null : "c2" }));
    }) as unknown as typeof fetch;
    expect(await activeGrantIdsOf({ readApiUrl: "http://api/", circle: "agents-main", fetch: fetchFn })("gpu.near")).toEqual([2, 3, 5]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/x207/circles/agents-main/grants?grantee=gpu.near&status=active");
  });

  it("fails on a read API error", async () => {
    const fetchFn = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    await expect(activeGrantIdsOf({ readApiUrl: "http://api", circle: "c", fetch: fetchFn })("gpu.near")).rejects.toThrow(/503/);
  });
});
