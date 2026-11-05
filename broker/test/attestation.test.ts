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
const via = (handler: (r: Request) => Promise<Response>): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch;

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
    expect(await fetchAttestation("http://b.test", { fetch })).toMatchObject({ mode: "none", reason: NO_TEE_REASON });
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
    await fetchAttestation("http://b.test/", { nonce: "ab".repeat(16), fetch: (async (_u: unknown, i?: RequestInit) => { init = i; return new Response(JSON.stringify({ mode: "none", reason: "x", nonce: "ab".repeat(16) })); }) as typeof fetch });
    expect(init?.redirect).toBe("error");
  });

  it("TC-BK-009-08 the nonce of the request is repeated by the broker in both modes, handed to the Attestor and to the verifier; a bad nonce is 400", async () => {
    const nonce = "0123456789abcdef0123456789abcdef";
    const seen: Array<string | undefined> = [];
    const attestor: Attestor = { quote: async (n) => { seen.push(n); return QUOTE; }, verify: async () => ({ valid: true }) };
    expect(await (await handlerWith(attestor)(new Request(`http://b.test/attestation?nonce=${nonce}`))).json()).toMatchObject({ mode: "tee", nonce, codeHash: RELEASE });
    expect(await (await handlerWith()(new Request(`http://b.test/attestation?nonce=${nonce}`))).json()).toEqual({ mode: "none", reason: NO_TEE_REASON, nonce });
    expect(await (await handlerWith()(new Request("http://b.test/attestation"))).json()).toEqual({ mode: "none", reason: NO_TEE_REASON });
    expect(seen).toEqual([nonce]);
    for (const bad of ["zz", "abcd", "ab".repeat(65), "abc", "0x" + "ab".repeat(16)]) {
      const r = await handlerWith()(new Request(`http://b.test/attestation?nonce=${bad}`));
      expect([r.status, ((await r.json()) as { error: string }).error], bad).toEqual([400, "bad_nonce"]);
    }
    // the client sends a fresh nonce each time and the verifier gets the one it sent
    const urls: string[] = [];
    const verified: Array<string | undefined> = [];
    const spy = (async (input: string | URL | Request, init?: RequestInit) => { urls.push(String(input)); return via(handlerWith(fakeTee()))(input, init); }) as typeof fetch;
    const verifier: Attestor = { quote: async () => null, verify: async (q, e, n) => { verified.push(n); return fakeTee().verify(q, e); } };
    await fetchAttestation("http://b.test", { fetch: spy, requireTee: true, expectedCodeHash: RELEASE, verifier });
    await fetchAttestation("http://b.test", { fetch: spy, requireTee: true, expectedCodeHash: RELEASE, verifier });
    expect(urls[0]).not.toBe(urls[1]);
    expect(urls.map((u) => /nonce=([0-9a-f]{32})$/.exec(u)?.[1])).toEqual(verified);
  });

  it("TC-BK-009-09 an answer that repeats another nonce, or none, is refused as nonce_mismatch: a recorded answer cannot be replayed, in tee mode or in none mode", async () => {
    const recorded = JSON.stringify({ mode: "tee", quote: QUOTE.quote, codeHash: RELEASE, nonce: "11".repeat(16) });
    const replay = (async () => new Response(recorded)) as typeof fetch;
    const options = { requireTee: true, expectedCodeHash: RELEASE, verifier: fakeTee() };
    expect(await fetchAttestation("http://b.test", { ...options, fetch: replay }).catch((e) => e)).toMatchObject({ code: "nonce_mismatch" });
    expect(await fetchAttestation("http://b.test", { ...options, nonce: "22".repeat(16), fetch: replay }).catch((e) => e)).toMatchObject({ code: "nonce_mismatch" });
    const noEcho = (async () => new Response(JSON.stringify({ mode: "tee", quote: QUOTE.quote, codeHash: RELEASE }))) as typeof fetch;
    expect(await fetchAttestation("http://b.test", { ...options, fetch: noEcho }).catch((e) => e)).toMatchObject({ code: "nonce_mismatch" });
    const oldNone = (async () => new Response(JSON.stringify({ mode: "none", reason: "x", nonce: "11".repeat(16) }))) as typeof fetch;
    expect(await fetchAttestation("http://b.test", { fetch: oldNone }).catch((e) => e)).toMatchObject({ code: "nonce_mismatch" });
    // the same nonce in upper case is the same nonce; a nonce the client chose is accepted when repeated
    const echo = (async (input: string | URL | Request) => new Response(JSON.stringify({ mode: "none", reason: "x", nonce: new URL(String(input)).searchParams.get("nonce")!.toUpperCase() }))) as typeof fetch;
    expect(await fetchAttestation("http://b.test", { fetch: echo, nonce: "ab".repeat(8) })).toMatchObject({ mode: "none" });
    expect(await fetchAttestation("http://b.test", { fetch: echo, nonce: "zz" }).catch((e) => e)).toMatchObject({ code: "bad_answer" });
  });
});
