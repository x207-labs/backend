// Security review batch 8 (BE-059 fix): the shared HTTP helper of the adapters. (1) A provider that echoes the credential of the request in the body of an error must not carry it into the
// message of the error: that message is stored (`last_error`), logged and shown to the lessee in GET access. (2) A provider answer is read up to a limit, not whole.
import { describe, expect, it } from "vitest";
import { CloudFolderShareAdapter, MessagingSubaccountAdapter, OAuthScopedAdapter, ProviderAccessManager, type FetchLike } from "../src/provider/index.js";
import { call, MAX_ANSWER_BYTES, ProviderHttpError } from "../src/provider/http.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const TOKEN = "opaque-admin-token-without-any-known-prefix-7f3a9c1e5b20";
const DAY = 86_400_000;
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();

/** A provider that is down and answers every request with an error that repeats what it was sent. */
const echoing: FetchLike = async (_url, init) => new Response(`upstream error; request had headers ${JSON.stringify(init?.headers ?? {})} and body ${String(init?.body ?? "")}`, { status: 502 });

describe("security review batch 8: the shared HTTP helper", () => {
  it("TC-BE-059-S1 a bearer token that the provider echoes in an error is taken out of the message", async () => {
    const error = await call(echoing, "https://p.test", { authorization: `Bearer ${TOKEN}` }, { method: "POST", path: "/x", body: "{}" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as Error).message).toMatch(/HTTP 502/);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).toContain("[redacted]");
  });

  it("TC-BE-059-S2 the Basic credential of a client (id and secret, and the base64 of both) is taken out too", async () => {
    const secret = "client-secret-opaque-0123456789abcdef";
    const basic = Buffer.from(`app:${secret}`).toString("base64");
    const error = (await call(echoing, "https://p.test", { authorization: `Basic ${basic}` }, { method: "POST", path: "/x" }).catch((e: unknown) => e)) as Error;
    for (const leaked of [basic, secret, `app:${secret}`]) expect(error.message).not.toContain(leaked);
  });

  it("TC-BE-059-S3 through an adapter and the manager: the stored last_error and the grant failure do not hold the admin token", async () => {
    const adapter = new MessagingSubaccountAdapter({ baseUrl: "https://msg.test/v1", token: TOKEN, fetch: echoing, now: () => NOW });
    const store = new BrokerStore(":memory:");
    const m = new ProviderAccessManager({ store, now: () => NOW });
    m.register(adapter);
    const input = { grant_id: 1, limits: { scope: JSON.stringify({ provider: "messaging-subaccount", grantee_ref: "agent-andi", resource: "3", permission: "5" }), expires_at: NS(NOW + 10 * DAY) } };
    const failure = (await m.grantAccess(input).catch((e: Error) => e)) as Error;
    expect(failure.message).toMatch(/provider_grant_failed/);
    expect(failure.message).not.toContain(TOKEN);
    store.close();
    const o = new OAuthScopedAdapter({ tokenUrl: "https://i.test/t", revocationUrl: "https://i.test/r", introspectionUrl: "https://i.test/i", clientId: "app", clientSecret: TOKEN, allowedScopes: ["a"], fetch: echoing });
    const oauthError = (await o.grant({ grantId: 1, granteeRef: "x", resource: "a", permission: null, expiresAtMs: NOW + DAY }).catch((e: Error) => e)) as Error;
    expect(oauthError.message).not.toContain(TOKEN);
    expect(oauthError.message).not.toContain(Buffer.from(`app:${TOKEN}`).toString("base64"));
    const f = new CloudFolderShareAdapter({ baseUrl: "https://s.test/api", token: TOKEN, allowedFolders: ["a"], fetch: echoing });
    const folderError = (await f.grant({ grantId: 1, granteeRef: "x", resource: "a/b", permission: null, expiresAtMs: NOW + DAY }).catch((e: Error) => e)) as Error;
    expect(folderError.message).not.toContain(TOKEN);
  });

  it("TC-BE-059-S4 an answer larger than the limit is refused before it is read whole, and a normal answer passes", async () => {
    const big = new Uint8Array(MAX_ANSWER_BYTES + 5000).fill(65);
    const huge: FetchLike = async () => new Response(big, { status: 200 });
    const error = (await call(huge, "https://p.test", {}, { method: "GET", path: "/x" }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error.message).toMatch(/larger than/);
    const ok: FetchLike = async () => new Response('{"ok":true}', { status: 200 });
    expect((await call(ok, "https://p.test", {}, { method: "GET", path: "/x" })).text).toBe('{"ok":true}');
  });
});
