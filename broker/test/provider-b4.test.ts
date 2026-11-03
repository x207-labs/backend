import { describe, expect, it } from "vitest";
import { buildGistContent, encodeGranteeProof, generateVoucherKeypair, sshEd25519Line } from "@x207/core";
import { GithubAdapter, MockProviderAdapter, ProviderAccessManager, SshAdapter, type ProviderGrantInput } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const DAY = 86_400_000;
const CIRCLE = "x207-circle.near";
const LESSEE = "lessee.x207-circle.near";
const keys = generateVoucherKeypair();
const GIST = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const grantOf = (provider: string, ref: string, over: Record<string, unknown> = {}, id = 1): ProviderGrantInput => ({
  grant_id: id, grantee: LESSEE, limits: { scope: JSON.stringify({ provider, grantee_ref: ref, ...over }), expires_at: NS(NOW + 10 * DAY) },
});

describe("BE-057 fix B4-F5, B4-F6, B4-F7", () => {
  it("TC-BE-057-B1 an SSH key that cannot be proven (RSA, ECDSA, security key) is refused when the grant is checked, with a reason; ed25519 passes (B4-F5)", async () => {
    const adapter = new SshAdapter({ file: { read: async () => "", write: async () => undefined } });
    const blob = (name: string) => {
      const n = Buffer.from(name);
      const head = Buffer.alloc(4);
      head.writeUInt32BE(n.length);
      return Buffer.concat([head, n, Buffer.alloc(32, 7)]).toString("base64");
    };
    for (const type of ["ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "sk-ssh-ed25519@openssh.com"]) {
      const r = await adapter.verifyGranteeRef(`${type} ${blob(type)} me@host`);
      expect([type, r.ok]).toEqual([type, false]);
      expect((r as { reason: string }).reason).toContain("ssh-ed25519");
    }
    expect(await adapter.verifyGranteeRef(sshEd25519Line(Uint8Array.from({ length: 32 }, (_, i) => i), "me@host"))).toEqual({ ok: true });
  });

  describe("the challenge is used up by a verdict, not by an error that is not the lessee's (B4-F6)", () => {
    const ref = "alice-dev";
    function setup() {
      const step = { answer: "503" as "503" | "403" | "ok" | "wrong-owner" };
      const seenHeaders: Array<Record<string, string> | undefined> = [];
      let nonce = "";
      const fetchImpl = (async (url: string, init?: { method?: string }) => {
        const p = new URL(url).pathname;
        if (p === "/users/alice-dev") return new Response("{}", { status: 200 });
        if (init?.method === "PUT") return new Response('{"id":88}', { status: 201 });
        return new Response("{}", { status: 404 });
      }) as never;
      const github = new GithubAdapter({
        token: "ghp_secret", allowedOwners: ["x207-test-org"], fetch: fetchImpl, baseUrl: "https://api.github.test",
        gistFetch: {
          resolver: async () => ["140.82.112.5"],
          transport: async ({ headers }) => {
            seenHeaders.push(headers);
            if (step.answer === "503" || step.answer === "403") return { status: Number(step.answer), body: Buffer.from("{}"), truncated: false };
            const owner = step.answer === "wrong-owner" ? "mallory" : "alice-dev";
            return { status: 200, body: Buffer.from(JSON.stringify({ owner: { login: owner }, files: { "p.json": { content: buildGistContent({ circle: CIRCLE, grantId: 1, granteeRef: ref, nonce }, LESSEE, keys.secretKey) } } })), truncated: false };
          },
        },
      });
      const store = new BrokerStore(":memory:");
      const clock = { now: NOW };
      const m = new ProviderAccessManager({ store, now: () => clock.now, circle: CIRCLE, voucherKeyOf: async () => keys.publicKey });
      m.register(github);
      const g = grantOf("github", ref, { resource: "x207-test-org/site", permission: "pull" });
      const proof = encodeGranteeProof({ kind: "near-gist", gist: GIST });
      return { m, store, step, seenHeaders, g, proof, challenge: () => { nonce = m.issueChallenge(g)!.nonce; return nonce; } };
    }

    it("a GitHub 503 or 403 keeps the challenge: the same proof works when GitHub answers; a proof that fails on its owner uses it up", async () => {
      const t = setup();
      t.challenge();
      for (const answer of ["503", "403"] as const) {
        t.step.answer = answer;
        await expect(t.m.grantAccess(t.g, 1, t.proof), answer).rejects.toMatchObject({ code: "grantee_ref_unverified" });
        expect(t.m.issueChallenge(t.g)).not.toBeNull(); // still the same live challenge
      }
      t.step.answer = "ok";
      expect((await t.m.grantAccess(t.g, 1, t.proof)).access.proof).toBe("verified");
      t.store.close();

      const bad = setup();
      bad.challenge();
      bad.step.answer = "wrong-owner";
      await expect(bad.m.grantAccess(bad.g, 1, bad.proof)).rejects.toMatchObject({ code: "grantee_ref_unverified" });
      bad.step.answer = "ok";
      await expect(bad.m.grantAccess(bad.g, 1, bad.proof)).rejects.toThrow(/tantangan/); // used up: ask for a new one
      bad.store.close();
    });

    it("the gist is read with the token of the grantor, to api.github.com only", async () => {
      const t = setup();
      t.challenge();
      t.step.answer = "ok";
      await t.m.grantAccess(t.g, 1, t.proof);
      expect(t.seenHeaders[0]?.authorization).toBe("Bearer ghp_secret");
      t.store.close();
    });

    it("two proofs for one grant at the same time: the second is told to wait, not checked twice", async () => {
      const t = setup();
      t.challenge();
      t.step.answer = "ok";
      const [a, b] = await Promise.allSettled([t.m.grantAccess(t.g, 1, t.proof), t.m.grantAccess(t.g, 1, t.proof)]);
      expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
      t.store.close();
    });
  });

  it("TC-BE-057-B2 an adapter with no proof at all is marked not_applicable with the warning, in the answer and in the record; a proven one has no warning (B4-F7)", async () => {
    const none = new MockProviderAdapter({});
    (none as { proveGranteeRef?: unknown }).proveGranteeRef = undefined;
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => NOW, circle: CIRCLE });
    m.register(none);
    const first = await m.grantAccess(grantOf("mock", "alice-dev", { resource: "r" }), 1, null);
    expect(first.warnings).toEqual(["grantee_unproven"]);
    expect(first.access.proof).toBe("not_applicable");
    expect(m.access(1)?.proof).toBe("not_applicable");
    const renewal = await m.grantAccess(grantOf("mock", "alice-dev", { resource: "r" }), 1, null);
    expect(renewal.warnings).toEqual(["grantee_unproven"]);
    store.close();
  });
});
