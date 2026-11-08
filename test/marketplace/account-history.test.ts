import { describe, expect, it } from "vitest";
import { FastNearAccountHistory } from "../../src/marketplace/account-history.js";

const MPC = "v1.signer-prod.testnet";
const INDEX = "https://tx.test.fastnear.com/v0/account";
// base58 look-alikes: only the alphabet and the length are checked
const h = (n: number): string => `${String(n).padStart(2, "1")}${"A".repeat(40)}`;

/** A fake of the index (`/account`) and of the transactions endpoint, the shapes read from the public testnet index. */
function fakeFetch(pages: Array<Array<Record<string, unknown>>>, txs: Record<string, { receiver: string; methods: string[] }>, calls: string[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(String(url));
    if (String(url) === INDEX) {
      const i = body.resume_token === undefined ? 0 : Number(body.resume_token);
      return Response.json({ account_txs: pages[i] ?? [], resume_token: i + 1 < pages.length ? String(i + 1) : null });
    }
    if (String(url) === "https://tx.test.fastnear.com/v0/transactions") {
      return Response.json({ transactions: (body.tx_hashes as string[]).map((hash) => ({ transaction: { receiver_id: txs[hash]!.receiver, actions: txs[hash]!.methods.map((m) => ({ FunctionCall: { method_name: m, args: "e30=" } })) } })) });
    }
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
}
const entry = (n: number, flags: Record<string, boolean> = {}) => ({ transaction_hash: h(n), is_signer: true, is_function_call: true, ...flags });

describe("BE-110 sign history over the FastNEAR index", () => {
  it("TC-BE-110-40 counts the sign calls to the MPC contract across pages; other methods and other receivers do not count", async () => {
    const f = fakeFetch(
      [[entry(1), entry(2)], [entry(3), entry(4)]],
      { [h(1)]: { receiver: MPC, methods: ["sign"] }, [h(2)]: { receiver: MPC, methods: ["public_key"] }, [h(3)]: { receiver: "other.testnet", methods: ["sign"] }, [h(4)]: { receiver: MPC, methods: ["sign", "sign"] } },
    );
    expect(await new FastNearAccountHistory({ txIndexUrl: INDEX, mpcContractId: MPC, fetch: f }).signCalls("a.testnet")).toEqual({ count: 2, complete: true });
  });

  it("TC-BE-110-41 an account with no sign call (and one that signed nothing) is zero and complete", async () => {
    const calls: string[] = [];
    const f = fakeFetch([[entry(1)]], { [h(1)]: { receiver: "x.testnet", methods: ["ping"] } }, calls);
    expect(await new FastNearAccountHistory({ txIndexUrl: INDEX, mpcContractId: MPC, fetch: f }).signCalls("a.testnet")).toEqual({ count: 0, complete: true });
    expect(await new FastNearAccountHistory({ txIndexUrl: INDEX, mpcContractId: MPC, fetch: fakeFetch([[]], {}) }).signCalls("b.testnet")).toEqual({ count: 0, complete: true });
  });

  it("TC-BE-110-42 only transactions that the account signed as a function call are looked up (a transfer received, a call from another signer are not)", async () => {
    const calls: string[] = [];
    const f = fakeFetch([[entry(1, { is_signer: false }), entry(2, { is_function_call: false }), entry(3)]], { [h(3)]: { receiver: MPC, methods: ["sign"] } }, calls);
    expect(await new FastNearAccountHistory({ txIndexUrl: INDEX, mpcContractId: MPC, fetch: f }).signCalls("a.testnet")).toEqual({ count: 1, complete: true });
    expect(calls.filter((c) => c.endsWith("/transactions"))).toHaveLength(1);
  });

  it("TC-BE-110-43 more pages than the limit is complete=false, not zero; an answer of the index that is an error throws", async () => {
    const pages = [[entry(1)], [entry(2)], [entry(3)]];
    const txs = { [h(1)]: { receiver: "x", methods: [] }, [h(2)]: { receiver: "x", methods: [] }, [h(3)]: { receiver: "x", methods: [] } };
    expect(await new FastNearAccountHistory({ txIndexUrl: INDEX, mpcContractId: MPC, fetch: fakeFetch(pages, txs), maxPages: 2 }).signCalls("a.testnet")).toEqual({ count: 0, complete: false });
    const failing = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    await expect(new FastNearAccountHistory({ txIndexUrl: INDEX, mpcContractId: MPC, fetch: failing }).signCalls("a.testnet")).rejects.toThrow("transaction index answered 503");
  });
});
