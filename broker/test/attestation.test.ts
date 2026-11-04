import { describe, expect, it } from "vitest";
import { attestationBody, NoAttestation, NO_TEE_REASON, type Attestor, type Quote } from "../src/attest/index.js";
import { AttestationError, fetchAttestation } from "../src/attest/client.js";
import { createBrokerHandler } from "../src/server.js";
import { routeLabel } from "../src/ops.js";

const RELEASE = "sha256:" + "a".repeat(64);
const QUOTE: Quote = { quote: "tdx-quote-bytes", codeHash: RELEASE };

/** A fake enclave: the quote it gives and a verifier that accepts only the quote text it knows. */
const fakeTee = (quote: Quote | null = QUOTE): Attestor => ({
  quote: async () => quote,
  verify: async (q, expected) => (q.quote === "tdx-quote-bytes" && q.codeHash === expected ? { valid: true } : { valid: false, reason: "quote_signature_invalid" }),
});

const handlerWith = (attestor?: Attestor) =>
  createBrokerHandler({ dispatcher: {} as never, classB: {} as never, facilitatorUrl: "http://f.test", circleId: "c", brokerAccount: "b.test", ...(attestor ? { attestor } : {}) });

/** A `fetch` that is served by the handler, as the client would reach a broker. */
const via = (handler: (r: Request) => Promise<Response>): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;

describe("BK-009 GET /attestation and the client that requires a TEE", () => {
  it("TC-BK-009-02 a broker without a TEE answers {mode:none, reason}; the route is counted by name and a POST is 405", async () => {
    const handler = handlerWith();
    const response = await handler(new Request("http://b.test/attestation"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mode: "none", reason: NO_TEE_REASON });
    expect((await handler(new Request("http://b.test/attestation", { method: "POST" }))).status).toBe(405);
    expect(routeLabel("/attestation", "GET")).toBe("attestation");
    expect(await attestationBody(new NoAttestation())).toEqual({ mode: "none", reason: NO_TEE_REASON });
  });

  it("TC-BK-009-03 without requireTee the client reports mode none; with requireTee it refuses with tee_required", async () => {
    const fetch = via(handlerWith());
    expect(await fetchAttestation("http://b.test", { fetch })).toEqual({ mode: "none", reason: NO_TEE_REASON });
    const refusal = await fetchAttestation("http://b.test", { fetch, requireTee: true, expectedCodeHash: RELEASE, verifier: fakeTee() }).catch((e) => e);
    expect(refusal).toBeInstanceOf(AttestationError);
    expect(refusal).toMatchObject({ code: "tee_required" });
    expect((refusal as Error).message).toContain("TEE");
  });

  it("TC-BK-009-04 a verified quote with the released code hash is accepted", async () => {
    const result = await fetchAttestation("http://b.test", { fetch: via(handlerWith(fakeTee())), requireTee: true, expectedCodeHash: RELEASE, verifier: fakeTee() });
    expect(result).toEqual({ mode: "tee", verified: true, codeHash: RELEASE });
  });

  it("TC-BK-009-05 a broker with another code hash is refused before the quote is looked at; a bad quote is refused", async () => {
    const other = fakeTee({ quote: "tdx-quote-bytes", codeHash: "sha256:" + "b".repeat(64) });
    expect(await fetchAttestation("http://b.test", { fetch: via(handlerWith(other)), requireTee: true, expectedCodeHash: RELEASE, verifier: fakeTee() }).catch((e) => e)).toMatchObject({ code: "code_hash_mismatch" });
    const forged = fakeTee({ quote: "forged", codeHash: RELEASE });
    expect(await fetchAttestation("http://b.test", { fetch: via(handlerWith(forged)), requireTee: true, expectedCodeHash: RELEASE, verifier: fakeTee() }).catch((e) => e)).toMatchObject({ code: "quote_invalid" });
  });

  it("TC-BK-009-06 the word mode:tee of the broker is not enough: without a verifier and the released hash the client refuses, requireTee or not", async () => {
    const fetch = via(handlerWith(fakeTee()));
    expect(await fetchAttestation("http://b.test", { fetch, requireTee: true }).catch((e) => e)).toMatchObject({ code: "no_verifier" });
    expect(await fetchAttestation("http://b.test", { fetch }).catch((e) => e)).toMatchObject({ code: "no_verifier" });
  });

  it("TC-BK-009-07 an answer that is not one of the two shapes, a non-200 and a redirect are refused", async () => {
    const answer = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    for (const body of [{}, { mode: "none" }, { mode: "tee", quote: "q" }, { mode: "maybe", reason: "x" }, null, "tee"]) {
      expect(await fetchAttestation("http://b.test", { fetch: answer(body) }).catch((e) => e), JSON.stringify(body)).toMatchObject({ code: "bad_answer" });
    }
    expect(await fetchAttestation("http://b.test", { fetch: answer({ mode: "none", reason: "x" }, 500) }).catch((e) => e)).toMatchObject({ code: "bad_answer" });
    let init: RequestInit | undefined;
    await fetchAttestation("http://b.test/", { fetch: (async (_u: unknown, i?: RequestInit) => { init = i; return new Response(JSON.stringify({ mode: "none", reason: "x" })); }) as typeof fetch });
    expect(init?.redirect).toBe("error");
  });
});
