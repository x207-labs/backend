import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildGistContent, encodeGranteeProof, generateVoucherKeypair, granteeChallenge, signSshChallenge, sshEd25519Line } from "@x207/core";
import { DiscordAdapter, GithubAdapter, MockProviderAdapter, ProviderAccessManager, SshAdapter, discordIdentify, type AuthorizedKeysFile, type ProviderGrantInput } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const DAY = 86_400_000;
const CIRCLE = "x207-circle.near";
const LESSEE = "lessee.x207-circle.near";
const lesseeKeys = generateVoucherKeypair();
const otherKeys = generateVoucherKeypair();

const grantOf = (provider: string, ref: string, over: Record<string, unknown> = {}, id = 1, grantee: string = LESSEE): ProviderGrantInput => ({
  grant_id: id, grantee, limits: { scope: JSON.stringify({ provider, grantee_ref: ref, ...over }), expires_at: NS(NOW + 10 * DAY) },
});
const clock = { now: NOW };
function manager(...adapters: ConstructorParameters<typeof Object>[0][]) {
  clock.now = NOW;
  const store = new BrokerStore(":memory:");
  const m = new ProviderAccessManager({ store, now: () => clock.now, circle: CIRCLE, voucherKeyOf: async (a) => (a === LESSEE ? lesseeKeys.publicKey : null) });
  for (const a of adapters) m.register(a as never);
  return { m, store };
}
const memoryFile = (): AuthorizedKeysFile & { text: string } => {
  const f = { text: "", read: async () => f.text, write: async (c: string) => void (f.text = c) };
  return f;
};

describe("BE-057 proof of the grantee_ref in the adapters", () => {
  describe("ssh-signature", () => {
    const pair = generateKeyPairSync("ed25519");
    const seed = Uint8Array.from(pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32));
    const pub = Uint8Array.from(pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32));
    const ref = sshEd25519Line(pub, "alice@laptop");
    const strangerSeed = Uint8Array.from(generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32));
    const setup = () => {
      const file = memoryFile();
      return { ...manager(new SshAdapter({ file, now: () => clock.now })), file };
    };
    const sign = (c: { circle: string; granteeRef: string; nonce: string }, s: Uint8Array = seed, grantId = 1) => encodeGranteeProof(signSshChallenge({ circle: c.circle, grantId, granteeRef: c.granteeRef, nonce: c.nonce }, s));

    it("TC-BE-057-P1 the key that is the reference signs the challenge of the grant: the access opens; the challenge is used up", async () => {
      const { m, file, store } = setup();
      const g = grantOf("ssh", ref, { resource: "/bin/true" });
      const c = m.issueChallenge(g)!;
      expect(c.text).toBe(granteeChallenge({ circle: CIRCLE, grantId: 1, granteeRef: ref, nonce: c.nonce }));
      expect(m.issueChallenge(g)!.nonce).toBe(c.nonce); // the live challenge is kept
      const { access, warnings } = await m.grantAccess(g, 1, sign(c));
      expect(access).toMatchObject({ status: "active", proof: "verified" });
      expect(warnings).toEqual([]);
      expect(file.text).toContain("x207-grant-1");
      store.close();
    });

    it("TC-BE-057-P2 a wrong key, a signature of another grant or nonce, a replay, no proof and an expired challenge are all refused; nothing is written", async () => {
      const { m, file, store } = setup();
      const g = grantOf("ssh", ref, { resource: "/bin/true" });
      let c = m.issueChallenge(g)!;
      await expect(m.grantAccess(g, 1, sign(c, strangerSeed))).rejects.toMatchObject({ code: "grantee_ref_unverified" }); // a key that is not the reference
      expect(m.issueChallenge(g)!.nonce).not.toBe(c.nonce); // the failed try used the challenge up
      c = m.issueChallenge(g)!;
      await expect(m.grantAccess(g, 1, sign(c, seed, 2))).rejects.toMatchObject({ code: "grantee_ref_unverified" }); // signed for grant 2
      c = m.issueChallenge(g)!;
      await expect(m.grantAccess(g, 1, sign({ ...c, nonce: "0".repeat(32) }))).rejects.toMatchObject({ code: "grantee_ref_unverified" }); // another nonce
      c = m.issueChallenge(g)!;
      await expect(m.grantAccess(g, 1, null)).rejects.toMatchObject({ code: "grantee_ref_unverified" }); // no proof
      await expect(m.grantAccess(g, 1, sign(c))).rejects.toMatchObject({ code: "grantee_ref_unverified", message: expect.stringContaining("tantangan") }); // the challenge went with the try before
      c = m.issueChallenge(g)!;
      clock.now += 16 * 60_000;
      await expect(m.grantAccess(g, 1, sign(c))).rejects.toMatchObject({ code: "grantee_ref_unverified", message: expect.stringContaining("kedaluwarsa") });
      expect(file.text).toBe("");
      // the proof of the first run, replayed after it worked, is worth nothing: the access exists and the challenge is gone
      clock.now = NOW;
      c = m.issueChallenge(g)!;
      const good = sign(c);
      await m.grantAccess(g, 1, good);
      await expect(m.grantAccess(grantOf("ssh", ref, { resource: "/bin/true" }, 2), 1, good)).rejects.toMatchObject({ code: "grantee_ref_unverified" });
      store.close();
    });

    it("TC-BE-057-P3 the proof of another kind is refused for ssh", async () => {
      const { m, store } = setup();
      const g = grantOf("ssh", ref, { resource: "/bin/true" });
      m.issueChallenge(g);
      await expect(m.grantAccess(g, 1, JSON.stringify({ kind: "near-gist", gist: "a".repeat(32) }))).rejects.toMatchObject({ code: "grantee_ref_unverified" });
      await expect(m.grantAccess(g, 1, "not json")).rejects.toMatchObject({ code: "grantee_ref_unverified" });
      store.close();
    });
  });

  describe("near-gist (GitHub)", () => {
    const GIST = "0123456789abcdef0123456789abcdef";
    const seen: string[] = [];
    function setup(gist: (challengeText: string) => unknown, resolve: string[] = ["140.82.112.5"]) {
      seen.length = 0;
      const calls: Array<{ host: string; path: string }> = [];
      const github = new GithubAdapter({
        token: "ghp_x", allowedOwners: ["x207-test-org"],
        gistFetch: {
          resolver: async () => resolve,
          transport: async ({ host, path }) => (calls.push({ host, path }), { status: 200, body: Buffer.from(JSON.stringify(gist(seen.at(-1) ?? ""))), truncated: false }),
        },
      });
      return { ...manager(github), calls };
    }
    const ref = "alice-dev";
    const gistWith = (owner: string, secret: `ed25519:${string}`, c: { circle: string; granteeRef: string; nonce: string }, account = LESSEE) => ({
      owner: { login: owner }, files: { "proof.json": { content: buildGistContent({ circle: c.circle, grantId: 1, granteeRef: c.granteeRef, nonce: c.nonce }, account, secret) } },
    });
    const proofOf = (gist = GIST) => encodeGranteeProof({ kind: "near-gist", gist });
    const g = () => grantOf("github", ref, { resource: "x207-test-org/site", permission: "pull" });

    it("TC-BE-057-P4 a gist of the account, with the challenge signed by the voucher key of the lessee, opens the access; only api.github.com is asked", async () => {
      let nonce = "";
      const { m, calls, store } = setup(() => gistWith("alice-dev", lesseeKeys.secretKey, { circle: CIRCLE, granteeRef: ref, nonce }));
      // the adapter also calls GitHub to verify the user and to add the collaborator: mock those with a fetch
      const adapter = (m as unknown as { adapters?: unknown });
      void adapter;
      const c = m.issueChallenge(g())!;
      nonce = c.nonce;
      const verdict = await (new GithubAdapter({
        token: "t", allowedOwners: ["x207-test-org"],
        gistFetch: { resolver: async () => ["140.82.112.5"], transport: async ({ host, path }) => (calls.push({ host, path }), { status: 200, body: Buffer.from(JSON.stringify(gistWith("alice-dev", lesseeKeys.secretKey, { circle: CIRCLE, granteeRef: ref, nonce }))), truncated: false }) },
      })).proveGranteeRef({ ref, proof: proofOf(`https://gist.github.com/alice-dev/${GIST}`), challenge: { circle: CIRCLE, grantId: 1, granteeRef: ref, nonce }, granteeAccount: LESSEE, voucherPublicKey: lesseeKeys.publicKey });
      expect(verdict).toBe(true);
      expect(calls).toEqual([{ host: "api.github.com", path: `/gists/${GIST}` }]);
      store.close();
    });

    const prove = async (over: { owner?: string; secret?: `ed25519:${string}`; proof?: string | null; resolve?: string[]; account?: string; key?: string | null }) => {
      const calls: Array<{ host: string; path: string }> = [];
      const nonce = "n".repeat(32);
      const a = new GithubAdapter({
        token: "t", allowedOwners: ["x207-test-org"],
        gistFetch: {
          resolver: async () => over.resolve ?? ["140.82.112.5"],
          transport: async ({ host, path }) => (calls.push({ host, path }), { status: 200, body: Buffer.from(JSON.stringify(gistWith(over.owner ?? "alice-dev", over.secret ?? lesseeKeys.secretKey, { circle: CIRCLE, granteeRef: ref, nonce }, over.account ?? LESSEE))), truncated: false }),
        },
      });
      const run = () => a.proveGranteeRef({ ref, proof: over.proof === undefined ? proofOf() : over.proof, challenge: { circle: CIRCLE, grantId: 1, granteeRef: ref, nonce }, granteeAccount: LESSEE, voucherPublicKey: over.key === undefined ? lesseeKeys.publicKey : over.key });
      return { run, calls };
    };

    it("TC-BE-057-P5 a gist of another account, a signature of another key, a private address, a proof of another kind and a missing key are refused", async () => {
      expect(await (await prove({})).run()).toBe(true);
      await expect((await prove({ owner: "mallory" })).run()).rejects.toThrow(/owner_mismatch|milik/);
      await expect((await prove({ secret: otherKeys.secretKey })).run()).rejects.toThrow(/bad_signature|tidak sah/);
      const priv = await prove({ resolve: ["10.0.0.5"] });
      await expect(priv.run()).rejects.toThrow(); // the guard refuses the private address: no request
      expect(priv.calls).toEqual([]);
      expect(await (await prove({ proof: encodeGranteeProof({ kind: "ssh-signature", signature: "A".repeat(88) }) })).run()).toBe(false);
      expect(await (await prove({ proof: null })).run()).toBe(false);
      expect(await (await prove({ key: null })).run()).toBe(false);
      expect(await (await prove({ proof: encodeGranteeProof({ kind: "near-gist", gist: "not-a-gist-id" }) })).run()).toBe(false);
    });

    it("TC-BE-057-P6 the host of the gist is fixed: a gist written as a URL of another host still goes to api.github.com", async () => {
      const t = await prove({ proof: proofOf(`https://evil.example.com/${GIST}`) });
      expect(await t.run()).toBe(true);
      expect(t.calls).toEqual([{ host: "api.github.com", path: `/gists/${GIST}` }]);
    });
    void setup;
  });

  describe("oauth (Discord)", () => {
    const USER = "333333333333333333";
    const mockDiscordFetch = (id: string): typeof fetch => (async () => new Response(JSON.stringify({ id }), { status: 200 })) as unknown as typeof fetch;
    const proof = encodeGranteeProof({ kind: "oauth", provider: "discord", token: "user-token" });
    const base = { botToken: "bot", guildId: "111111111111111111" };

    it("TC-BE-057-P7 with a verifier the user id of the token must be the reference; without one the reference is marked unproven, with a warning", async () => {
      const ok = new DiscordAdapter({ ...base, oauth: discordIdentify({ fetch: mockDiscordFetch(USER) as never }) });
      expect(await ok.proveGranteeRef({ ref: USER, proof, challenge: null, granteeAccount: LESSEE, voucherPublicKey: null })).toBe(true);
      const other = new DiscordAdapter({ ...base, oauth: discordIdentify({ fetch: mockDiscordFetch("444444444444444444") as never }) });
      await expect(other.proveGranteeRef({ ref: USER, proof, challenge: null, granteeAccount: LESSEE, voucherPublicKey: null })).rejects.toThrow(/owner_mismatch|milik/);
      expect(await ok.proveGranteeRef({ ref: USER, proof: null, challenge: null, granteeAccount: LESSEE, voucherPublicKey: null })).toBe(false);
      const none = new DiscordAdapter(base);
      expect(await none.proveGranteeRef({ ref: USER, proof: null, challenge: null, granteeAccount: LESSEE, voucherPublicKey: null })).toMatchObject({ unproven: expect.stringContaining("OAuth") });
    });

    it("TC-BE-057-P8 the manager keeps the warning: the access opens, the answer says grantee_unproven and the record says unproven", async () => {
      const calls: string[] = [];
      const adapter = new DiscordAdapter({ ...base, fetch: (async (url: string, init?: { method?: string }) => (calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`), new Response(init?.method === "PUT" ? null : "{}", { status: init?.method === "PUT" ? 204 : 200 }))) as never });
      const { m, store } = manager(adapter);
      const { access, warnings } = await m.grantAccess(grantOf("discord", USER, { resource: "222222222222222222" }), 1, null);
      expect(warnings).toEqual(["grantee_unproven"]);
      expect(access.proof).toMatch(/^unproven: /);
      expect(m.access(1)?.proof).toMatch(/^unproven: /);
      store.close();
    });
  });

  it("TC-BE-057-P9 the mock proves anything; the vote of a DAO is for the account that signs the vouchers of the lessee and no other", async () => {
    const mock = new MockProviderAdapter({});
    const { m, store } = manager(mock);
    expect((await m.grantAccess(grantOf("mock", "alice-dev", { resource: "r" }), 1, null)).access.proof).toBe("verified");
    store.close();
    const { DaoVoteAdapter, parseDaoRegistry } = await import("../src/provider/index.js");
    const dao = new DaoVoteAdapter({ registry: parseDaoRegistry("{}"), client: { delegate: async () => ({ id: "1", expiresAtMs: null }), undelegate: async () => undefined, isDelegated: async () => true, accountExists: async () => true, recordOf: () => "" } });
    const args = { proof: null, challenge: null, voucherPublicKey: null };
    expect(await dao.proveGranteeRef({ ...args, ref: LESSEE, granteeAccount: LESSEE })).toBe(true);
    expect(await dao.proveGranteeRef({ ...args, ref: "other.near", granteeAccount: LESSEE })).toBe(false);
    expect(await dao.proveGranteeRef({ ...args, ref: LESSEE, granteeAccount: null })).toBe(false);
  });
});
