import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { AwsStsAdapter, DiscordAdapter, GithubAdapter, ProviderAccessManager, RETRY_BASE_MS, STS_MIN_SECONDS, signPost, type FetchLike } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const DAY = 86_400_000;
const TOKEN = "ghp_TESTTOKEN_do_not_leak_0123456789";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}
/** A fetch that answers from a table `"METHOD /path" -> [status, body]` (the first match of the path, query ignored) and records what it was asked. */
function mockFetch(table: Record<string, [number, string] | Array<[number, string]>>) {
  const seen: Seen[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    seen.push({ method: init?.method ?? "GET", url, headers: init?.headers ?? {}, body: init?.body });
    const entry = table[key];
    const [status, body] = entry === undefined ? [599, `no mock for ${key}`] : Array.isArray(entry[0]) ? ((entry as Array<[number, string]>).length > 1 ? (entry as Array<[number, string]>).shift()! : (entry as Array<[number, string]>)[0]!) : (entry as [number, string]);
    return new Response(status === 204 ? null : body, { status, headers: status === 429 ? { "retry-after": "2" } : {} });
  };
  return { fetchImpl, seen };
}
const input = (provider: string, ref: string, resource: string | null, over: Record<string, unknown> = {}, id = 1) => ({
  grant_id: id, limits: { scope: JSON.stringify({ provider, grantee_ref: ref, resource, ...over }), expires_at: NS(NOW + 10 * DAY) },
});

describe("BE-059 GitHub adapter (mock HTTP)", () => {
  const make = (table: Parameters<typeof mockFetch>[0], owners = ["x207-test-org"]) => {
    const m = mockFetch(table);
    return { ...m, adapter: new GithubAdapter({ token: TOKEN, allowedOwners: owners, fetch: m.fetchImpl, baseUrl: "https://api.github.test" }) };
  };

  it("TC-BE-059-01 a repository collaborator: the user is checked, invited with the permission, and removed with the invitation", async () => {
    const { adapter, seen } = make({
      "GET /users/alice-dev": [200, '{"login":"alice-dev"}'], "GET /users/ghost-nobody": [404, '{"message":"Not Found"}'],
      "PUT /repos/x207-test-org/site/collaborators/alice-dev": [201, '{"id":777}'],
      "DELETE /repos/x207-test-org/site/invitations/777": [204, ""], "DELETE /repos/x207-test-org/site/collaborators/alice-dev": [204, ""],
      "GET /repos/x207-test-org/site/collaborators/alice-dev": [404, ""],
    });
    expect(await adapter.verifyGranteeRef("alice-dev")).toEqual({ ok: true });
    expect(await adapter.verifyGranteeRef("ghost-nobody")).toMatchObject({ ok: false });
    expect(await adapter.verifyGranteeRef("bad login!")).toMatchObject({ ok: false });
    const g = await adapter.grant({ grantId: 1, granteeRef: "alice-dev", resource: "x207-test-org/site", permission: "push", expiresAtMs: NOW + DAY });
    expect(g).toMatchObject({ handle: "gh:x207-test-org/site:alice-dev", nativeExpiresAtMs: null, delivery: { invitation: "pending", permission: "push" } });
    const put = seen.find((s) => s.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({ permission: "push" });
    expect(put.headers.authorization).toBe(`Bearer ${TOKEN}`);
    await adapter.revoke(g.handle);
    expect(seen.filter((s) => s.method === "DELETE").map((s) => new URL(s.url).pathname)).toEqual(["/repos/x207-test-org/site/invitations/777", "/repos/x207-test-org/site/collaborators/alice-dev"]);
    expect(await adapter.status(g.handle)).toBe("absent");
    // the token is in no answer the lessee gets
    expect(JSON.stringify(g)).not.toContain(TOKEN);
  });

  it("TC-BE-059-02 an organization seat; a repository of another owner, a bad resource or a permission outside the list are refused before any call", async () => {
    const { adapter, seen } = make({
      "PUT /orgs/x207-test-org/memberships/bob-dev": [200, '{"state":"pending"}'], "DELETE /orgs/x207-test-org/memberships/bob-dev": [204, ""],
    });
    const seat = await adapter.grant({ grantId: 2, granteeRef: "bob-dev", resource: "org:x207-test-org", permission: null, expiresAtMs: NOW + DAY });
    expect(seat).toMatchObject({ handle: "gh:org:x207-test-org:bob-dev", delivery: { membership: "pending" } });
    await adapter.revoke(seat.handle);
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(["PUT /orgs/x207-test-org/memberships/bob-dev", "DELETE /orgs/x207-test-org/memberships/bob-dev"]);
    seen.length = 0;
    for (const resource of ["evil-org/site", "org:evil-org", "x207-test-org/../admin", "x207-test-org/a/b", "x207-test-org", null]) {
      await expect(adapter.grant({ grantId: 3, granteeRef: "bob-dev", resource, permission: null, expiresAtMs: NOW + DAY }), String(resource)).rejects.toThrow();
    }
    await expect(adapter.grant({ grantId: 3, granteeRef: "bob-dev", resource: "x207-test-org/site", permission: "owner", expiresAtMs: NOW + DAY })).rejects.toThrow(/permission/);
    expect(seen).toEqual([]);
  });

  it("TC-BE-059-03 a failing API leaves the access revoke_pending in the manager, and the retry removes it; the error text holds no token", async () => {
    const answers: Array<[number, string]> = [[503, "unavailable"], [204, ""]];
    const { adapter } = make({ "GET /users/alice-dev": [200, "{}"], "PUT /repos/x207-test-org/site/collaborators/alice-dev": [204, ""], "DELETE /repos/x207-test-org/site/collaborators/alice-dev": answers });
    const clock = { now: NOW };
    const store = new BrokerStore(":memory:");
    const manager = new ProviderAccessManager({ store, now: () => clock.now });
    (adapter as { needsChallenge: boolean }).needsChallenge = false;
    adapter.proveGranteeRef = async () => true; // about the revoke here; the proof has its own tests
    manager.register(adapter);
    await manager.grantAccess(input("github", "alice-dev", "x207-test-org/site", { permission: "pull" }));
    clock.now = NOW + DAY + 1;
    const first = (await manager.sweep())[0]!;
    expect(first.status).toBe("revoke_pending");
    expect(first.lastError).toContain("HTTP 503");
    expect(first.lastError).not.toContain(TOKEN);
    clock.now += RETRY_BASE_MS;
    expect((await manager.sweep())[0]!.status).toBe("revoked");
    store.close();
  });
});

describe("BE-059 Discord adapter (mock HTTP)", () => {
  const GUILD = "111111111111111111";
  const ROLE = "222222222222222222";
  const USER = "333333333333333333";
  const make = (table: Parameters<typeof mockFetch>[0], allowedRoleIds: string[] = [ROLE]) => {
    const m = mockFetch(table);
    return { ...m, adapter: new DiscordAdapter({ botToken: "BOT_SECRET_TOKEN", guildId: GUILD, allowedRoleIds, fetch: m.fetchImpl, baseUrl: "https://discord.test/api/v10" }) };
  };

  it("TC-BE-059-04 a role for a member of the server: checked, given, seen, taken back; a user who is not a member and a role outside the list are refused", async () => {
    const path = `/api/v10/guilds/${GUILD}/members/${USER}`;
    const { adapter, seen } = make({
      [`GET ${path}`]: [200, JSON.stringify({ roles: [ROLE] })], [`GET /api/v10/guilds/${GUILD}/members/444444444444444444`]: [404, '{"message":"Unknown Member"}'],
      [`PUT ${path}/roles/${ROLE}`]: [204, ""], [`DELETE ${path}/roles/${ROLE}`]: [204, ""],
    });
    expect(await adapter.verifyGranteeRef(USER)).toEqual({ ok: true });
    expect(await adapter.verifyGranteeRef("444444444444444444")).toMatchObject({ ok: false });
    expect(await adapter.verifyGranteeRef("not-a-snowflake")).toMatchObject({ ok: false });
    const g = await adapter.grant({ grantId: 1, granteeRef: USER, resource: ROLE, permission: null, expiresAtMs: NOW + DAY });
    expect(g.handle).toBe(`discord:${GUILD}:${USER}:${ROLE}`);
    expect(seen.find((s) => s.method === "PUT")!.headers.authorization).toBe("Bot BOT_SECRET_TOKEN");
    expect(await adapter.status(g.handle)).toBe("active");
    await adapter.revoke(g.handle);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE" });
    await expect(adapter.grant({ grantId: 2, granteeRef: USER, resource: "555555555555555555", permission: null, expiresAtMs: NOW + DAY })).rejects.toThrow(/allowedRoleIds/);
    await expect(adapter.grant({ grantId: 2, granteeRef: USER, resource: null, permission: null, expiresAtMs: NOW + DAY })).rejects.toThrow();
    expect(JSON.stringify(g)).not.toContain("BOT_SECRET_TOKEN");
  });

  it("TC-BE-059-05 a role that is already gone, or a member who left, is a successful revoke; a rate limit is an error to retry", async () => {
    const path = `/api/v10/guilds/${GUILD}/members/${USER}/roles/${ROLE}`;
    const { adapter } = make({ [`DELETE ${path}`]: [404, ""] });
    await expect(adapter.revoke(`discord:${GUILD}:${USER}:${ROLE}`)).resolves.toBeUndefined();
    const limited = make({ [`DELETE ${path}`]: [429, '{"retry_after":2}'] });
    await expect(limited.adapter.revoke(`discord:${GUILD}:${USER}:${ROLE}`)).rejects.toMatchObject({ status: 429, retryAfter: 2 });
    expect(() => new DiscordAdapter({ botToken: "x", guildId: "abc" })).toThrow();
  });
});

describe("BE-059 AWS STS adapter with a permission boundary (mock HTTP)", () => {
  const ROLE = "arn:aws:iam::123456789012:role/x207-rent";
  const BOUNDARY = "arn:aws:iam::123456789012:policy/x207-boundary";
  const KEY = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "SECRET_ACCESS_KEY_do_not_leak" };
  const iamOk = `<GetRoleResponse><GetRoleResult><Role><PermissionsBoundary><PermissionsBoundaryArn>${BOUNDARY}</PermissionsBoundaryArn></PermissionsBoundary></Role></GetRoleResult></GetRoleResponse>`;
  const iamNone = "<GetRoleResponse><GetRoleResult><Role><RoleName>x207-rent</RoleName></Role></GetRoleResult></GetRoleResponse>";
  const stsOk = (expiration: string) => `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIATEMP</AccessKeyId><SecretAccessKey>tempsecret</SecretAccessKey><SessionToken>tok</SessionToken><Expiration>${expiration}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`;
  function make(iam: string, expiration = new Date(NOW + DAY / 2).toISOString()) {
    const m = mockFetch({ "POST /": [200, "x"] });
    const fetchImpl: FetchLike = async (url, init) => {
      m.seen.push({ method: init?.method ?? "GET", url, headers: init?.headers ?? {}, body: init?.body });
      return new Response(url.includes("iam.") ? iam : stsOk(expiration), { status: 200 });
    };
    return { ...m, adapter: new AwsStsAdapter({ ...KEY, permissionsBoundaryArn: BOUNDARY, allowedRoleArns: [ROLE], fetch: fetchImpl, now: () => NOW, stsUrl: "https://sts.test/", iamUrl: "https://iam.test/" }) };
  }
  const req = (over = {}) => ({ grantId: 1, granteeRef: "carol-session", resource: ROLE, permission: "s3:GetObject", expiresAtMs: NOW + DAY, ...over });

  it("TC-BE-059-06 a role with the boundary gets a session of the paid length with a narrower session policy; the signed request does not carry the key", async () => {
    const { adapter, seen } = make(iamOk);
    const g = await adapter.grant(req());
    // a session lasts 12 hours at most, so it ends before the paid day and is made again with the rent of the next day
    expect(g).toMatchObject({ nativeExpiresAtMs: NOW + DAY / 2, delivery: { credentials: { accessKeyId: "ASIATEMP", sessionToken: "tok" } } });
    const [iam, sts] = seen;
    expect(new URLSearchParams(iam!.body).get("Action")).toBe("GetRole");
    const params = new URLSearchParams(sts!.body);
    expect(Object.fromEntries(params)).toMatchObject({ Action: "AssumeRole", RoleArn: ROLE, RoleSessionName: "carol-session", DurationSeconds: "43200" });
    expect(JSON.parse(params.get("Policy")!)).toMatchObject({ Statement: [{ Effect: "Allow", Action: ["s3:GetObject"] }] });
    expect(sts!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    for (const s of seen) expect(JSON.stringify(s)).not.toContain(KEY.secretAccessKey);
    expect(await adapter.status(g.handle)).toBe("active");
  });

  it("TC-BE-059-07 a role without the boundary is refused before AssumeRole; a role outside the list, and a rent shorter than the STS floor, are refused too", async () => {
    const none = make(iamNone);
    await expect(none.adapter.grant(req())).rejects.toThrow(/permission boundary/);
    expect(none.seen.map((s) => new URLSearchParams(s.body).get("Action"))).toEqual(["GetRole"]);
    const ok = make(iamOk);
    await expect(ok.adapter.grant(req({ resource: "arn:aws:iam::123456789012:role/other" }))).rejects.toThrow(/allowedRoleArns/);
    await expect(ok.adapter.grant(req({ expiresAtMs: NOW + (STS_MIN_SECONDS - 1) * 1000 }))).rejects.toThrow(/batas bawah/);
    await expect(ok.adapter.grant(req({ resource: "not-an-arn" }))).rejects.toThrow();
    expect(ok.seen).toEqual([]);
  });

  it("TC-BE-059-08 the signing is deterministic and depends on the body, the date and the key", () => {
    const a = signPost({ ...KEY, region: "us-east-1", service: "sts", host: "sts.amazonaws.com", body: "Action=X", nowMs: NOW });
    expect(signPost({ ...KEY, region: "us-east-1", service: "sts", host: "sts.amazonaws.com", body: "Action=X", nowMs: NOW })).toEqual(a);
    expect(signPost({ ...KEY, region: "us-east-1", service: "sts", host: "sts.amazonaws.com", body: "Action=Y", nowMs: NOW }).authorization).not.toBe(a.authorization);
    expect(signPost({ ...KEY, secretAccessKey: "other", region: "us-east-1", service: "sts", host: "sts.amazonaws.com", body: "Action=X", nowMs: NOW }).authorization).not.toBe(a.authorization);
    expect(a["x-amz-date"]).toBe("20261105T100000Z");
  });
});

/** The `.env` of the project root, read without printing anything. Only these names are looked at. */
function testEnv(): Record<string, string> {
  const names = ["GITHUB_TEST_TOKEN", "GITHUB_TEST_ORG", "GITHUB_TEST_REPO", "GITHUB_TEST_GRANTEE", "DISCORD_TEST_BOT_TOKEN", "DISCORD_TEST_GUILD_ID", "DISCORD_TEST_GRANTEE_ID", "DISCORD_TEST_ROLE_ID"];
  const out: Record<string, string> = {};
  let file = "";
  try {
    file = readFileSync(new URL("../../../../../.env", import.meta.url), "utf8");
  } catch {
    // no .env: the real tests are skipped
  }
  for (const line of file.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && names.includes(m[1] as string) && (m[2] as string).trim() !== "") out[m[1] as string] = (m[2] as string).trim().replace(/^["']|["']$/g, "");
  }
  for (const n of names) if (process.env[n]) out[n] = process.env[n] as string;
  return out;
}
const env = testEnv();
const hasAll = (...names: string[]): boolean => names.every((n) => Boolean(env[n]));

// Rules of the real tests: access is given only to the grantee named in the environment (never to another account, so no invitation reaches a stranger), it is always taken back
// at the end, also when a test fails, a test is skipped when any variable it needs is empty, and no value is printed.
describe("BE-059 real accounts of the owner (skipped unless every variable is set; the values are never printed)", () => {
  const github = { handle: null as string | null, adapter: null as GithubAdapter | null };
  const discord = { handle: null as string | null, adapter: null as DiscordAdapter | null };
  afterAll(async () => {
    if (github.adapter && github.handle) await github.adapter.revoke(github.handle).catch(() => undefined);
    if (discord.adapter && discord.handle) await discord.adapter.revoke(discord.handle).catch(() => undefined);
  });

  it.skipIf(!hasAll("GITHUB_TEST_TOKEN", "GITHUB_TEST_ORG", "GITHUB_TEST_REPO", "GITHUB_TEST_GRANTEE"))("TC-BE-059-09 GitHub: the grantee of the owner is looked up and invited as a collaborator to the test repository, then removed", async () => {
    const adapter = new GithubAdapter({ token: env.GITHUB_TEST_TOKEN!, allowedOwners: [env.GITHUB_TEST_ORG!] });
    github.adapter = adapter;
    expect(await adapter.verifyGranteeRef(env.GITHUB_TEST_GRANTEE!)).toEqual({ ok: true });
    expect(await adapter.verifyGranteeRef("x207-no-such-user-0123456789-zz")).toMatchObject({ ok: false });
    const g = await adapter.grant({ grantId: 9001, granteeRef: env.GITHUB_TEST_GRANTEE!, resource: `${env.GITHUB_TEST_ORG}/${env.GITHUB_TEST_REPO}`, permission: "pull", expiresAtMs: Date.now() + DAY });
    github.handle = g.handle;
    expect(["active", "absent"]).toContain(await adapter.status(g.handle));
    await adapter.revoke(g.handle);
    github.handle = null;
    expect(await adapter.status(g.handle)).toBe("absent");
  });

  it.skipIf(!hasAll("DISCORD_TEST_BOT_TOKEN", "DISCORD_TEST_GUILD_ID", "DISCORD_TEST_GRANTEE_ID", "DISCORD_TEST_ROLE_ID"))("TC-BE-059-10 Discord: the role of the owner is given to the grantee of the owner and taken back", async () => {
    const adapter = new DiscordAdapter({ botToken: env.DISCORD_TEST_BOT_TOKEN!, guildId: env.DISCORD_TEST_GUILD_ID!, allowedRoleIds: [env.DISCORD_TEST_ROLE_ID!] });
    discord.adapter = adapter;
    expect(await adapter.verifyGranteeRef(env.DISCORD_TEST_GRANTEE_ID!)).toEqual({ ok: true });
    const g = await adapter.grant({ grantId: 9002, granteeRef: env.DISCORD_TEST_GRANTEE_ID!, resource: env.DISCORD_TEST_ROLE_ID!, permission: null, expiresAtMs: Date.now() + DAY });
    discord.handle = g.handle;
    expect(await adapter.status(g.handle)).toBe("active");
    await adapter.revoke(g.handle);
    discord.handle = null;
    expect(await adapter.status(g.handle)).toBe("absent");
  });
});
