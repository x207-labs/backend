import { describe, expect, it } from "vitest";
import { nearAccountExists } from "../../src/settlement/deposit/quote.js";

const answer = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

describe("BE-027 nearAccountExists", () => {
  it("account exists", async () => {
    expect(await nearAccountExists("http://rpc", answer({ result: { amount: "1" } }))("a.near")).toBe(true);
  });
  it("account does not exist, old form in result.error", async () => {
    expect(await nearAccountExists("http://rpc", answer({ result: { error: "account a.near does not exist while viewing" } }))("a.near")).toBe(false);
  });
  it("account does not exist, current mainnet RPC form: error UNKNOWN_ACCOUNT", async () => {
    const body = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, code: -32000 } };
    expect(await nearAccountExists("http://rpc", answer(body))("a.near")).toBe(false);
  });
  it("other RPC errors are thrown", async () => {
    await expect(nearAccountExists("http://rpc", answer({ error: { cause: { name: "UNAVAILABLE_SHARD" } } }))("a.near")).rejects.toThrow(/view_account/);
  });
});
