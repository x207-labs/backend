import { afterEach, describe, expect, it } from "vitest";
import { intentHash, intentHashBase58, signIntent, type BarterIntent } from "@x207/core";
import { acct, CONTRACT, NOW_S, startMarket, type Market } from "./helpers.js";

describe("BE-035 buku intent barter (D8)", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  const intent = (name: string, over: Partial<BarterIntent> = {}): BarterIntent => ({
    circle: CONTRACT,
    account: acct(name),
    offer: { service: "translate", calls: 10, value: "100000000" },
    need: { service: "summarize", calls: 5, value: "100000000" },
    expiresAt: NOW_S + 3600,
    nonce: `n-${name}`,
    ...over,
  });
  const signed = (m: Market, name: string, over: Partial<BarterIntent> = {}) => {
    const i = intent(name, over);
    return { intent: i, signature: signIntent(i, m.keys[name]!.secretKey) };
  };

  it("tiga intent A/B/C tersimpan, terbaca kembali dan hash-nya cocok", async () => {
    market = await startMarket();
    const m = market;
    const posted = [];
    for (const name of ["andi", "budi", "citra"]) {
      const res = await m.post("/intents", signed(m, name));
      expect(res.status).toBe(201);
      posted.push({ name, ...res.json });
    }
    for (const p of posted) {
      const i = intent(p.name);
      expect(p.intentHash).toBe(intentHash(i));
      expect(p.intentHashBase58).toBe(intentHashBase58(i));
      expect(p.onchain).toEqual({ method: "post_intent", args: { intent_hash: intentHashBase58(i) }, posted: false });
      expect(p.status).toBe("open");
    }
    const list = await m.get("/intents?status=open");
    expect(list.status).toBe(200);
    expect(list.json.items.map((i: any) => i.account)).toEqual([acct("andi"), acct("budi"), acct("citra")]);
    expect(list.json.items[0]).toMatchObject({
      offer: { service: "translate", calls: 10, value: "100000000" },
      need: { service: "summarize", calls: 5, value: "100000000" },
      expiresAt: "2026-11-04T11:00:00Z",
    });
    expect(list.json.nextCursor).toBeNull();
  });

  it("status on-chain terbaca dari event intent_posted di events_raw", async () => {
    market = await startMarket();
    const m = market;
    const body = signed(m, "andi");
    await m.post("/intents", body);
    m.db
      .prepare(
        `INSERT INTO events_raw (receipt_id, log_index, block_height, block_hash, block_timestamp_ns, tx_hash, contract_id, standard, version, event, data_json, handled)
         VALUES ('r1', 0, 777, 'bh', 1, 'tx', ?, 'x207', '0.0.3', 'intent_posted', ?, 1)`,
      )
      .run(CONTRACT, JSON.stringify({ intent_hash: intentHashBase58(body.intent), account_id: acct("andi"), posted_at: "1" }));
    const list = await m.get("/intents?account=" + acct("andi"));
    expect(list.json.items[0].onchain).toMatchObject({ posted: true, blockHeight: 777 });
  });

  it("menolak tanda tangan akun lain, anggota tidak aktif, dan intent duplikat", async () => {
    market = await startMarket(["andi", "budi"], ["gita"]);
    const m = market;
    const forged = { intent: intent("andi"), signature: signIntent(intent("andi"), m.keys.budi!.secretKey) };
    const bad = await m.post("/intents", forged);
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe("invalid_signature");

    const inactive = await m.post("/intents", signed(m, "gita"));
    expect(inactive.status).toBe(403);
    expect(inactive.json.error.code).toBe("member_not_active");

    const stranger = await m.post("/intents", { intent: intent("zed"), signature: signIntent(intent("zed"), m.keys.andi!.secretKey) });
    expect(stranger.status).toBe(404);
    expect(stranger.json.error.code).toBe("member_not_found");

    const ok = await m.post("/intents", signed(m, "andi"));
    expect(ok.status).toBe(201);
    const dup = await m.post("/intents", signed(m, "andi"));
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("already_exists");
  });

  it("menolak isi yang cacat: lingkaran salah, kedaluwarsa, format, body bukan intent", async () => {
    market = await startMarket();
    const m = market;
    expect((await m.post("/intents", signed(m, "andi", { circle: "other.near" }))).status).toBe(400);
    expect((await m.post("/intents", signed(m, "andi", { expiresAt: NOW_S - 1 }))).status).toBe(400);
    const badFormat = await m.post("/intents", { intent: intent("andi", { offer: { service: "Bad Name", calls: 1, value: "1" } }), signature: "ed25519:x" });
    expect(badFormat.status).toBe(400);
    expect(badFormat.json.error.code).toBe("invalid_request");
    expect((await m.post("/intents", { signature: "x" })).status).toBe(400);
    expect((await m.post("/intents", [])).status).toBe(400);
  });

  it("intent kedaluwarsa hilang dari status=open dan muncul di status=expired", async () => {
    market = await startMarket();
    const m = market;
    await m.post("/intents", signed(m, "andi", { expiresAt: NOW_S + 60 }));
    await m.post("/intents", signed(m, "budi"));
    m.clock.now += 120_000;
    const open = await m.get("/intents?status=open");
    expect(open.json.items.map((i: any) => i.account)).toEqual([acct("budi")]);
    const expired = await m.get("/intents?status=expired");
    expect(expired.json.items.map((i: any) => i.account)).toEqual([acct("andi")]);
    expect(expired.json.items[0].status).toBe("expired");
    expect((await m.get("/intents?status=all")).json.items).toHaveLength(2);
    expect((await m.get("/intents?status=bogus")).status).toBe(400);
  });

  it("paginasi dengan limit dan cursor", async () => {
    market = await startMarket();
    const m = market;
    for (const name of ["andi", "budi", "citra"]) await m.post("/intents", signed(m, name));
    const first = await m.get("/intents?limit=2");
    expect(first.json.items).toHaveLength(2);
    expect(first.json.nextCursor).not.toBeNull();
    const second = await m.get(`/intents?limit=2&cursor=${first.json.nextCursor}`);
    expect(second.json.items.map((i: any) => i.account)).toEqual([acct("citra")]);
    expect(second.json.nextCursor).toBeNull();
  });
});
