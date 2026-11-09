import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createApiServer } from "../../src/api/server.js";
import { faucetRoutes, FAUCET_DEFAULTS, type FaucetChain, type FaucetConfig } from "../../src/faucet/faucet.js";
import { faucetFromEnv } from "../../src/faucet/near-chain.js";
import type { AddressInfo } from "node:net";

const NEAR = 10n ** 24n;
const USDT = "usdt.x207-deployer.testnet";
const config: FaucetConfig = { ...FAUCET_DEFAULTS, usdtContract: USDT };
const IMPLICIT = "a".repeat(64);

class FakeChain implements FaucetChain {
  balances = new Map<string, bigint>();
  faucet = 50n * NEAR;
  transfers: Array<[string, bigint]> = [];
  mints: Array<[string, bigint]> = [];
  failTransfer = false;
  failMint = false;
  delayMs = 0;
  async balance(a: string) { return this.balances.get(a) ?? null; }
  async faucetBalance() { return this.faucet; }
  async transfer(a: string, y: bigint) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failTransfer) throw new Error("rpc down");
    this.transfers.push([a, y]);
    this.balances.set(a, (this.balances.get(a) ?? 0n) + y);
    return `tx-near-${this.transfers.length}`;
  }
  async fundUsdt(a: string, amount: bigint) {
    if (this.failMint) throw new Error("mint failed");
    this.mints.push([a, amount]);
    return [`tx-dep-${this.mints.length}`, `tx-mint-${this.mints.length}`];
  }
}

describe("BE-114 test-funds faucet", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  async function start(chain = new FakeChain(), over: Partial<FaucetConfig> = {}, opts: { readOnly?: boolean; trustProxy?: boolean } = { readOnly: true }) {
    const db = new Database(":memory:");
    const clock = { now: 1_800_000_000_000 };
    const srv = createApiServer({ db, now: () => clock.now, ...(opts.readOnly ? { readOnly: true } : {}), ...(opts.trustProxy ? { abuse: { trustProxy: true, ipPerMinute: 0, writeIpPerMinute: 0, writeAccountPerMinute: 0 } } : {}), extraRoutes: faucetRoutes(db, chain, { ...config, ...over }) });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    closers.push(async () => { await new Promise<void>((r) => srv.close(() => r())); db.close(); });
    const post = async (body: unknown, ip?: string) => {
      const res = await fetch(`${url}/x207/faucet`, { method: "POST", headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as any, retryAfter: res.headers.get("retry-after") };
    };
    return { db, chain, clock, url, post };
  }
  const code = (r: { status: number; json: any }) => [r.status, r.json.error?.code];

  it("TC-BE-114-01 a new account gets NEAR, a USDT storage deposit and a mint; the answer says what and which transactions; it works on a read-only server", async () => {
    const m = await start();
    m.chain.balances.set("newbie.testnet", 0n);
    const r = await m.post({ account_id: "newbie.testnet" });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({
      account_id: "newbie.testnet",
      near: { amount_yocto: config.nearYocto.toString(), tx: "tx-near-1" },
      usdt: { contract: USDT, amount: "300000000", txs: ["tx-dep-1", "tx-mint-1"] },
    });
    expect(m.chain.transfers).toEqual([["newbie.testnet", config.nearYocto]]);
    expect(m.chain.mints).toEqual([["newbie.testnet", 300_000_000n]]);
    expect(m.db.prepare("SELECT state FROM faucet_grants WHERE account_id = 'newbie.testnet'").get()).toEqual({ state: "sent" });
    const other = await fetch(`${m.url}/x207/circles/agents-main/listings`, { method: "POST", body: "{}" });
    expect(other.status).toBe(404); // read-only still refuses every other POST
  });

  it("TC-BE-114-02 an account gets one grant, ever: the second request is refused and sends nothing", async () => {
    const m = await start();
    m.chain.balances.set("once.testnet", 0n);
    expect((await m.post({ account_id: "once.testnet" })).status).toBe(201);
    m.chain.balances.set("once.testnet", 0n); // even if it spent everything
    expect(code(await m.post({ account_id: "once.testnet" }))).toEqual([409, "faucet_already_claimed"]);
    expect(m.chain.transfers).toHaveLength(1);
  });

  it("TC-BE-114-03 a named account that does not exist is refused; an implicit one is funded (the transfer creates it); a refused request does not use up the quota", async () => {
    const m = await start(new FakeChain(), { perIpPerDay: 1 });
    expect(code(await m.post({ account_id: "ghost.testnet" }))).toEqual([404, "faucet_account_not_found"]);
    expect(m.db.prepare("SELECT COUNT(*) AS n FROM faucet_grants").get()).toEqual({ n: 0 });
    expect((await m.post({ account_id: IMPLICIT })).status).toBe(201);
    expect(m.chain.transfers[0]![0]).toBe(IMPLICIT);
  });

  it("TC-BE-114-04 an account that holds funds already is refused", async () => {
    const m = await start();
    m.chain.balances.set("rich.testnet", 5n * NEAR);
    expect(code(await m.post({ account_id: "rich.testnet" }))).toEqual([409, "faucet_already_funded"]);
    expect(m.chain.transfers).toHaveLength(0);
    m.chain.balances.set("poor.testnet", NEAR / 2n);
    expect((await m.post({ account_id: "poor.testnet" })).status).toBe(201);
  });

  it("TC-BE-114-05 per address: three grants a day, the fourth is 429 with Retry-After, and the next day it works again", async () => {
    const m = await start();
    for (const n of ["a1", "a2", "a3"]) { m.chain.balances.set(`${n}.testnet`, 0n); expect((await m.post({ account_id: `${n}.testnet` })).status).toBe(201); m.clock.now += 1000; }
    m.chain.balances.set("a4.testnet", 0n);
    const r = await m.post({ account_id: "a4.testnet" });
    expect([r.status, r.json.error.code, r.json.error.details.scope]).toEqual([429, "rate_limited", "faucet_ip"]);
    expect(Number(r.retryAfter)).toBeGreaterThan(86_000);
    m.clock.now += 86_400_000;
    expect((await m.post({ account_id: "a4.testnet" })).status).toBe(201);
  });

  it("TC-BE-114-06 per day for everybody: the quota is shared by all addresses; behind the proxy the address is the last hop of X-Forwarded-For", async () => {
    const m = await start(new FakeChain(), { perDay: 2 }, { trustProxy: true });
    for (const [n, ip] of [["b1", "1.1.1.1"], ["b2", "2.2.2.2"]] as const) { m.chain.balances.set(`${n}.testnet`, 0n); expect((await m.post({ account_id: `${n}.testnet` }, `9.9.9.9, ${ip}`)).status).toBe(201); }
    m.chain.balances.set("b3.testnet", 0n);
    const r = await m.post({ account_id: "b3.testnet" }, "3.3.3.3");
    expect([r.status, r.json.error.details.scope]).toEqual([429, "faucet_day"]);
    expect((await (await fetch(`${m.url}/x207/faucet`)).json()).remaining_today).toBe(0);
  });

  it("TC-BE-114-07 an empty faucet refuses (503) and sends nothing; the reserve is kept", async () => {
    const chain = new FakeChain();
    chain.faucet = config.nearYocto + config.reserveYocto - 1n;
    const m = await start(chain);
    chain.balances.set("late.testnet", 0n);
    expect(code(await m.post({ account_id: "late.testnet" }))).toEqual([503, "faucet_empty"]);
    expect(chain.transfers).toHaveLength(0);
    chain.faucet += 1n;
    expect((await m.post({ account_id: "late.testnet" })).status).toBe(201);
  });

  it("TC-BE-114-08 when the USDT step fails the NEAR is kept and the same request finishes the job without a second NEAR transfer", async () => {
    const chain = new FakeChain();
    chain.failMint = true;
    const m = await start(chain);
    chain.balances.set("half.testnet", 0n);
    const r = await m.post({ account_id: "half.testnet" });
    expect([r.status, r.json.error.code, r.json.error.details.near_tx]).toEqual([502, "faucet_partial", "tx-near-1"]);
    chain.failMint = false;
    const again = await m.post({ account_id: "half.testnet" });
    expect(again.status).toBe(201);
    expect(again.json.near.tx).toBe("tx-near-1");
    expect(chain.transfers).toHaveLength(1);
    expect(chain.mints).toEqual([["half.testnet", 300_000_000n]]);
  });

  it("TC-BE-114-09 when the NEAR transfer fails nothing stays reserved: the account may ask again", async () => {
    const chain = new FakeChain();
    chain.failTransfer = true;
    const m = await start(chain);
    chain.balances.set("retry.testnet", 0n);
    expect(code(await m.post({ account_id: "retry.testnet" }))).toEqual([502, "faucet_failed"]);
    chain.failTransfer = false;
    expect((await m.post({ account_id: "retry.testnet" })).status).toBe(201);
  });

  it("TC-BE-114-10 parallel requests for one account: one grant, one transfer", async () => {
    const chain = new FakeChain();
    chain.delayMs = 30;
    const m = await start(chain);
    chain.balances.set("race.testnet", 0n);
    const all = await Promise.all([1, 2, 3, 4].map(() => m.post({ account_id: "race.testnet" })));
    expect(all.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(chain.transfers).toHaveLength(1);
  });

  it("TC-BE-114-11 the input is checked: bad account, unknown field, bad include_usdt; include_usdt false sends NEAR only", async () => {
    const m = await start();
    for (const bad of ["", "UPPER.testnet", "a b", "x".repeat(65), 5]) expect(code(await m.post({ account_id: bad }))).toEqual([400, "faucet_bad_account"]);
    expect(code(await m.post({ account_id: "ok.testnet", amount: "1000" }))).toEqual([400, "invalid_request"]);
    expect(code(await m.post({ account_id: "ok.testnet", include_usdt: "yes" }))).toEqual([400, "invalid_request"]);
    expect(code(await m.post([]))).toEqual([400, "invalid_request"]);
    m.chain.balances.set("nearonly.testnet", 0n);
    const r = await m.post({ account_id: "nearonly.testnet", include_usdt: false });
    expect([r.status, r.json.usdt, m.chain.mints.length]).toEqual([201, null, 0]);
  });

  it("TC-BE-114-12 GET /x207/faucet says what is paid and what is left, and no key or account of the faucet", async () => {
    const m = await start();
    const g = await (await fetch(`${m.url}/x207/faucet`)).json();
    expect(g).toEqual({ enabled: true, near_yocto: config.nearYocto.toString(), usdt_amount: "300000000", usdt_contract: USDT, per_ip_per_day: 3, per_day: 100, remaining_today: 100 });
  });

  it("TC-BE-114-13 from the environment: off without settings; both settings or none; testnet accounts and RPCs only; the key is not in the config", () => {
    expect(faucetFromEnv({})).toBeUndefined();
    expect(() => faucetFromEnv({ X207_FAUCET_ACCOUNT: "f.testnet" })).toThrow(/together/);
    expect(() => faucetFromEnv({ X207_FAUCET_ACCOUNT: "f.near", X207_FAUCET_KEY: "ed25519:xx" })).toThrow(/testnet funds only/);
    expect(() => faucetFromEnv({ X207_FAUCET_ACCOUNT: "f.testnet", X207_FAUCET_KEY: "ed25519:xx", X207_FAUCET_RPC_URL: "https://rpc.mainnet.near.org" })).toThrow(/testnet funds only/);
    expect(() => faucetFromEnv({ X207_FAUCET_ACCOUNT: "f.testnet", X207_FAUCET_KEY: "secp256k1:xx" })).toThrow(/ed25519/);
    expect(() => faucetFromEnv({ X207_FAUCET_ACCOUNT: "f.testnet", X207_FAUCET_KEY: "ed25519:xx", X207_FAUCET_PER_DAY: "-1" })).toThrow(/whole number/);
  });
});
