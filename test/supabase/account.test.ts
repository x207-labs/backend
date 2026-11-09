import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { bytesToHex, nep413Hash, nep413Preimage, verifyNep413, NEP413_TAG, RECIPIENT, type SignedRequest } from "../../supabase/functions/x207-account/nep413.ts";
import { handleRequest, keyBelongsToAccount, type Deps, type Store } from "../../supabase/functions/x207-account/handler.ts";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

const NOW = 1_800_000_000_000;
interface Key { priv: KeyObject; pub: KeyObject; bytes: Uint8Array; publicKey: string }
function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bytes = Uint8Array.from(Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url"));
  return { priv: privateKey, pub: publicKey, bytes, publicKey: `ed25519:${base58Encode(bytes)}` };
}
function nonceAt(ms: number, salt = 7): Uint8Array {
  const n = new Uint8Array(32).fill(salt);
  new DataView(n.buffer).setBigUint64(0, BigInt(ms), false);
  return n;
}
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

async function signed(k: Key, accountId: string, action: string, over: { nonce?: Uint8Array; recipient?: string; message?: string; at?: number } = {}): Promise<SignedRequest> {
  const nonce = over.nonce ?? nonceAt(over.at ?? NOW, Math.floor(Math.random() * 250));
  const message = over.message ?? `x207:${action}`;
  const recipient = over.recipient ?? RECIPIENT;
  const hash = await nep413Hash(message, nonce, recipient);
  return { accountId, publicKey: k.publicKey, signature: b64(new Uint8Array(edSign(null, hash, k.priv))), message, nonce: b64(nonce), recipient };
}

class FakeStore implements Store {
  nonces = new Set<string>();
  profiles = new Map<string, any>();
  onboarding = new Map<string, any>();
  prefs = new Map<string, any>();
  feedback: any[] = [];
  async useNonce(n: string) { if (this.nonces.has(n)) return false; this.nonces.add(n); return true; }
  async getAll(a: string) { return { profile: this.profiles.get(a) ?? null, onboarding: this.onboarding.get(a) ?? null, prefs: this.prefs.get(a) ?? null }; }
  async upsertProfile(a: string, display_name: string) { this.profiles.set(a, { account_id: a, display_name }); }
  async upsertOnboarding(a: string, flags: object) { this.onboarding.set(a, { account_id: a, wallet_created: false, funds_received: false, joined: false, staked: false, tour_done: false, ...(this.onboarding.get(a) ?? {}), ...flags }); }
  async upsertPrefs(a: string, p: object) { this.prefs.set(a, { account_id: a, email: null, deadline_reminder: false, ...(this.prefs.get(a) ?? {}), ...p }); }
  async insertFeedback(row: any) { this.feedback.push(row); }
  async countFeedback(ipHash: string) { return this.feedback.filter((f) => f.ipHash === ipHash).length; }
}

/** rpc that knows the full access keys of some accounts; `FunctionCall` keys are given as `fc:<key>`. */
function fakeRpc(accounts: Record<string, string[]>, down = false): Deps["rpc"] {
  return async (_m, p: any) => {
    if (down) throw new Error("rpc down");
    const keys = accounts[p.account_id];
    if (!keys) return { error: { cause: { name: "UNKNOWN_ACCOUNT" } } };
    if (keys.includes(p.public_key)) return { result: { nonce: 1, permission: "FullAccess" } };
    if (keys.includes(`fc:${p.public_key}`)) return { result: { nonce: 1, permission: { FunctionCall: { allowance: "1", receiver_id: "x", method_names: [] } } } };
    return { error: { cause: { name: "UNKNOWN_ACCESS_KEY" } } };
  };
}

function setup(accounts: Record<string, string[]> = {}, opts: { down?: boolean; ip?: string } = {}) {
  const store = new FakeStore();
  const deps: Deps = { store, rpc: fakeRpc(accounts, opts.down), now: () => NOW, ip: opts.ip ?? "1.2.3.4", ipSalt: "salt" };
  const call = (body: unknown) => handleRequest(body, deps);
  return { store, deps, call };
}
const code = (a: { status: number; body: any }) => [a.status, a.body?.error?.code ?? "ok"];

describe("BE-116 NEP-413 verification", () => {
  it("TC-BE-116-01 the bytes that are hashed: the tag 2147484061 (little endian), the borsh strings, the 32 raw bytes of the nonce, the 0 of the absent callbackUrl", () => {
    expect(NEP413_TAG).toBe(2 ** 31 + 413);
    const pre = nep413Preimage("hi", new Uint8Array(32).fill(0xab), "r");
    const hex = bytesToHex(pre);
    expect(hex).toBe(["9d010080", "02000000" + "6869", "ab".repeat(32), "01000000" + "72", "00"].join(""));
  });

  it("TC-BE-116-02 a valid signature is accepted, whether it comes as base64 or as ed25519:base58; the signature is over the sha256 of the preimage", async () => {
    const k = newKey();
    const r = await signed(k, "alice.testnet", "get");
    expect((await verifyNep413(r, "get", NOW)).ok).toBe(true);
    const hash = createHash("sha256").update(nep413Preimage(r.message, Uint8Array.from(Buffer.from(r.nonce, "base64")), r.recipient)).digest();
    expect(edVerify(null, hash, k.pub, Buffer.from(r.signature, "base64"))).toBe(true);
    const b58 = { ...r, signature: `ed25519:${base58Encode(Uint8Array.from(Buffer.from(r.signature, "base64")))}` };
    expect((await verifyNep413(b58, "get", NOW)).ok).toBe(true);
  });

  it("TC-BE-116-03 invalid: a flipped bit, another key, another message, another recipient, a nonce of 5 minutes and a second, a nonce from the future, a short nonce, bad key and signature text", async () => {
    const k = newKey();
    const base = await signed(k, "alice.testnet", "get");
    const err = async (r: SignedRequest, action = "get") => { const v = await verifyNep413(r, action, NOW); return v.ok ? "ok" : v.error; };
    const flipped = Buffer.from(base.signature, "base64"); flipped[0] = flipped[0]! ^ 1;
    expect(await err({ ...base, signature: flipped.toString("base64") })).toBe("invalid_signature");
    expect(await err({ ...base, publicKey: newKey().publicKey })).toBe("invalid_signature");
    expect(await err(await signed(k, "alice.testnet", "get", { recipient: "evil.example" }))).toBe("wrong_recipient");
    expect(await err(await signed(k, "alice.testnet", "get", { message: "x207:upsert_profile" }))).toBe("wrong_message");
    expect(await err(base, "upsert_profile")).toBe("wrong_message"); // a signature for `get` does not do for another action
    expect(await err(await signed(k, "alice.testnet", "get", { at: NOW - 5 * 60_000 - 1 }))).toBe("nonce_expired");
    expect(await err(await signed(k, "alice.testnet", "get", { at: NOW - 5 * 60_000 + 1000 }))).toBe("ok");
    expect(await err(await signed(k, "alice.testnet", "get", { at: NOW + 61_000 }))).toBe("nonce_expired");
    expect(await err({ ...base, nonce: b64(new Uint8Array(16)) })).toBe("bad_nonce");
    expect(await err({ ...base, nonce: "not base64!" })).toBe("bad_nonce");
    expect(await err({ ...base, publicKey: "secp256k1:abc" })).toBe("bad_public_key");
    expect(await err({ ...base, publicKey: "ed25519:0OIl" })).toBe("bad_public_key");
    expect(await err({ ...base, signature: "AAAA" })).toBe("bad_signature_format");
    // the signature is over the nonce too: the same signature with another nonce fails
    expect(await err({ ...base, nonce: b64(nonceAt(NOW, 99)) })).toBe("invalid_signature");
  });
});

describe("BE-116 the Edge Function logic", () => {
  const alice = "alice.testnet";

  it("TC-BE-116-04 get: the signed owner reads their own rows; the same nonce a second time is refused", async () => {
    const k = newKey();
    const m = setup({ [alice]: [k.publicKey] });
    m.store.profiles.set(alice, { account_id: alice, display_name: "Alice" });
    m.store.profiles.set("bob.testnet", { account_id: "bob.testnet", display_name: "Bob" });
    const req = { action: "get", ...(await signed(k, alice, "get")) };
    const a = await m.call(req);
    expect(a.status).toBe(200);
    expect((a.body as any).profile.display_name).toBe("Alice");
    expect(code(await m.call(req))).toEqual([401, "nonce_used"]);
  });

  it("TC-BE-116-05 the key must be a full access key of the account: another account, a function call key, an unknown key, the network down; a refused request does not spend the nonce", async () => {
    const k = newKey();
    const other = newKey();
    const req = { action: "get", ...(await signed(k, alice, "get")) };
    expect(code(await setup({ [alice]: [other.publicKey] }).call(req))).toEqual([403, "key_not_owned"]);
    expect(code(await setup({ [alice]: [`fc:${k.publicKey}`] }).call(req))).toEqual([403, "key_not_owned"]);
    expect(code(await setup({ "bob.testnet": [k.publicKey] }).call(req))).toEqual([403, "key_not_owned"]); // the key is bob's, the claim is alice
    expect(code(await setup({}, { down: true }).call(req))).toEqual([503, "rpc_unavailable"]);
    const m = setup({ [alice]: [other.publicKey] });
    await m.call(req);
    expect(m.store.nonces.size).toBe(0);
  });

  it("TC-BE-116-06 an implicit account: if it does not exist yet, the key whose hex is the id is its key; another key is not; once it exists the RPC decides", async () => {
    const k = newKey();
    const id = bytesToHex(k.bytes);
    expect(code(await setup({}).call({ action: "get", ...(await signed(k, id, "get")) }))).toEqual([200, "ok"]);
    const wrong = newKey();
    expect(code(await setup({}).call({ action: "get", ...(await signed(wrong, id, "get")) }))).toEqual([403, "key_not_owned"]);
    expect(code(await setup({ [id]: [wrong.publicKey] }).call({ action: "get", ...(await signed(k, id, "get")) }))).toEqual([403, "key_not_owned"]); // it exists and removed that key
    expect(await keyBelongsToAccount(fakeRpc({}), "a.testnet", k.publicKey, k.bytes)).toBe("no");
  });

  it("TC-BE-116-07 upsert_profile: 1 to 40 characters, trimmed, no control characters; a bad value does not spend the nonce; the row is the signer's own", async () => {
    const k = newKey();
    const m = setup({ [alice]: [k.publicKey] });
    for (const bad of ["", "   ", "x".repeat(41), "tab\there", 5]) {
      const a = await m.call({ action: "upsert_profile", data: { display_name: bad }, ...(await signed(k, alice, "upsert_profile")) });
      expect(code(a)).toEqual([400, "invalid_request"]);
    }
    expect(code(await m.call({ action: "upsert_profile", data: { display_name: "ok", account_id: "bob.testnet" }, ...(await signed(k, alice, "upsert_profile")) }))).toEqual([400, "invalid_request"]);
    expect(m.store.nonces.size).toBe(0);
    const ok = await m.call({ action: "upsert_profile", data: { display_name: "  Alice A  " }, ...(await signed(k, alice, "upsert_profile")) });
    expect(ok.status).toBe(200);
    expect(m.store.profiles.get(alice).display_name).toBe("Alice A");
    expect([...m.store.profiles.keys()]).toEqual([alice]);
  });

  it("TC-BE-116-08 upsert_onboarding merges the flags it is given; an unknown step or a non-boolean is refused", async () => {
    const k = newKey();
    const m = setup({ [alice]: [k.publicKey] });
    const send = async (data: unknown) => m.call({ action: "upsert_onboarding", data, ...(await signed(k, alice, "upsert_onboarding")) });
    expect((await send({ wallet_created: true })).status).toBe(200);
    expect((await send({ funds_received: true, joined: true })).status).toBe(200);
    expect(m.store.onboarding.get(alice)).toMatchObject({ wallet_created: true, funds_received: true, joined: true, staked: false, tour_done: false });
    expect(code(await send({ admin: true }))).toEqual([400, "invalid_request"]);
    expect(code(await send({ staked: "yes" }))).toEqual([400, "invalid_request"]);
    expect(code(await send({}))).toEqual([400, "invalid_request"]);
  });

  it("TC-BE-116-09 upsert_prefs: an email or null, a boolean; an address that is not an email is refused", async () => {
    const k = newKey();
    const m = setup({ [alice]: [k.publicKey] });
    const send = async (data: unknown) => m.call({ action: "upsert_prefs", data, ...(await signed(k, alice, "upsert_prefs")) });
    expect((await send({ email: "a@example.com", deadline_reminder: true })).status).toBe(200);
    expect(m.store.prefs.get(alice)).toMatchObject({ email: "a@example.com", deadline_reminder: true });
    expect((await send({ email: null })).status).toBe(200);
    expect(m.store.prefs.get(alice)).toMatchObject({ email: null, deadline_reminder: true });
    for (const bad of [{ email: "nope" }, { email: 5 }, { deadline_reminder: "yes" }, {}, { other: 1 }]) expect(code(await send(bad))).toEqual([400, "invalid_request"]);
  });

  it("TC-BE-116-10 feedback needs no signature: 1 to 2000 characters, a page, five an hour per address; with a signature the account is kept; half a signature or a bad one is refused", async () => {
    const k = newKey();
    const m = setup({ [alice]: [k.publicKey] });
    const send = (data: unknown, extra: object = {}) => m.call({ action: "feedback", data, ...extra });
    expect((await send({ page: "/wizard", message: "hello" })).body).toEqual({ ok: true, signed: false });
    expect(m.store.feedback[0]).toMatchObject({ accountId: null, page: "/wizard", message: "hello" });
    expect(m.store.feedback[0].ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.store.feedback[0].ipHash).not.toContain("1.2.3.4");
    expect(code(await send({ page: "/x", message: "m".repeat(2001) }))).toEqual([400, "invalid_request"]);
    expect(code(await send({ page: "", message: "m" }))).toEqual([400, "invalid_request"]);
    expect(code(await send({ page: "/x", message: "m", extra: 1 }))).toEqual([400, "invalid_request"]);
    const s = await signed(k, alice, "feedback");
    expect(code(await send({ page: "/x", message: "m" }, { accountId: alice }))).toEqual([400, "invalid_request"]);
    expect(code(await send({ page: "/x", message: "m" }, { ...s, signature: b64(Uint8Array.from(Buffer.from(s.signature, "base64"), (x, i) => (i === 0 ? x ^ 1 : x))) }))).toEqual([401, "invalid_signature"]);
    expect((await send({ page: "/x", message: "signed" }, s)).body).toEqual({ ok: true, signed: true });
    expect(m.store.feedback.at(-1)).toMatchObject({ accountId: alice, message: "signed" });
    // 2 stored so far; three more fill the hour, the next is refused
    for (let i = 0; i < 3; i++) expect((await send({ page: "/x", message: `n${i}` })).status).toBe(201);
    expect(code(await send({ page: "/x", message: "too many" }))).toEqual([429, "rate_limited"]);
    // another address has its own count
    const other = setup({}, { ip: "9.9.9.9" });
    expect((await other.call({ action: "feedback", data: { page: "/x", message: "fine" } })).status).toBe(201);
  });

  it("TC-BE-116-11 the body: not an object, an unknown action, a missing field of the signature", async () => {
    const m = setup();
    expect(code(await m.call([]))).toEqual([400, "invalid_request"]);
    expect(code(await m.call({ action: "drop_tables" }))).toEqual([400, "invalid_request"]);
    expect(code(await m.call({ action: "get" }))).toEqual([400, "invalid_request"]);
    expect(code(await m.call({ action: "get", accountId: "Bad Account", publicKey: "a", signature: "b", message: "c", nonce: "d", recipient: "e" }))).toEqual([400, "invalid_request"]);
  });
});
