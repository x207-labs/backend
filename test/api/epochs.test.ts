import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listen, seedCircle, seedEpoch, ISO_NS, type TestServer } from "../helpers/d9-fixtures.js";

const BASE = "/x207/circles/agents-main";
const NOW = Date.parse("2026-11-09T11:25:00Z");

describe("BE-014 read API epoch list", () => {
  let db: Database.Database;
  let srv: TestServer;

  beforeEach(async () => {
    db = new Database(":memory:");
    seedCircle(db);
    seedEpoch(db, { epoch: 40, phase: "finalized", closedAt: "2026-11-09T08:19:56Z", proposalDeadline: "2026-11-09T08:29:56Z",
      committedAt: "2026-11-09T08:30:00Z", paymentDeadline: "2026-11-09T09:00:00Z", finalizedAt: "2026-11-09T09:00:30Z",
      edgeCount: 5, totalObligation: 100_000_000, cleared: 80_000_000 });
    seedEpoch(db, { epoch: 41, phase: "finalized", closedAt: "2026-11-09T09:19:56Z", proposalDeadline: "2026-11-09T09:29:56Z",
      committedAt: "2026-11-09T09:30:00Z", paymentDeadline: "2026-11-09T10:00:00Z", finalizedAt: "2026-11-09T10:00:30Z",
      edgeCount: 6, totalObligation: 150_000_000, cleared: 100_000_000 });
    seedEpoch(db, { epoch: 42, phase: "clearing", cutoffAt: "2026-11-09T11:19:56Z", closedAt: "2026-11-09T11:19:56Z",
      proposalDeadline: "2026-11-09T11:29:56Z", edgeCount: 7, totalObligation: 190_000_000 });
    seedEpoch(db, { epoch: 43, phase: "open", cutoffAt: "2026-11-09T12:19:56Z" });
    srv = await listen({ db, now: () => NOW });
  });

  afterEach(async () => {
    await srv.close();
    db.close();
  });

  it("TC-BE-014-12 epoch list in descending order with phase and proposalDeadline", async () => {
    const res = await fetch(srv.url + `${BASE}/epochs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unit).toBe("credit");
    expect(body.decimals).toBe(6);
    expect(body.items.map((e: { epoch: number }) => e.epoch)).toEqual([43, 42, 41, 40]);
    expect(body.items.map((e: { phase: string }) => e.phase)).toEqual(["open", "clearing", "finalized", "finalized"]);
    expect(body.items[1].proposalDeadline).toBe("2026-11-09T11:29:56Z");
    expect(body.items[3].paymentDeadline).toBe("2026-11-09T09:00:00Z");
    expect(body.items[1].totalObligation).toBe("190000000");
    expect(body.items[2].cleared).toBe("100000000");
    expect(body.nextCursor).toBeNull();
  });

  it("TC-BE-014-12b derived cutoff and commit phases are computed from time (K-41)", async () => {
    const at = async (iso: string) => {
      const s = await listen({ db, now: () => Date.parse(iso) });
      const body = await (await fetch(s.url + `${BASE}/epochs`)).json();
      await s.close();
      return Object.fromEntries(body.items.map((e: { epoch: number; phase: string }) => [e.epoch, e.phase]));
    };
    expect(await at("2026-11-09T11:25:00Z")).toMatchObject({ 42: "clearing", 43: "open" });
    expect(await at("2026-11-09T11:30:00Z")).toMatchObject({ 42: "commit", 43: "open" });
    expect(await at("2026-11-09T12:30:00Z")).toMatchObject({ 43: "cutoff" });
    expect(ISO_NS("2026-11-09T12:30:00Z")).toBeGreaterThan(0n);
  });

  it("TC-BE-067-01 an open epoch shows the live edge count and total from its obligations (the contract's get_epoch shows them), null while it has none; a closed epoch keeps what the event wrote", async () => {
    const empty = (await (await fetch(`${srv.url}${BASE}/epochs`)).json()).items.find((e: any) => e.epoch === 43);
    expect([empty.edgeCount, empty.totalObligation]).toEqual([null, null]);
    const ins = db.prepare("INSERT INTO obligations (circle_id, epoch, debtor, creditor, seq, cumulative_amount, registration_mode, registered_block, receipt_id) VALUES ('agents-main', 43, ?, ?, 1, ?, 'cumulative', 1, ?)");
    ins.run("a.near", "b.near", 10_000_000, "r1");
    ins.run("b.near", "c.near", 5_000_000, "r2");
    const items = (await (await fetch(`${srv.url}${BASE}/epochs`)).json()).items;
    const open = items.find((e: any) => e.epoch === 43);
    expect([open.edgeCount, open.totalObligation]).toEqual([2, "15000000"]);
    const closed = items.find((e: any) => e.epoch === 42);
    expect([closed.edgeCount, closed.totalObligation]).toEqual([7, "190000000"]);
  });

  it("TC-BE-014-13 epoch pagination 2/2", async () => {
    const first = await (await fetch(srv.url + `${BASE}/epochs?limit=2`)).json();
    expect(first.items.map((e: { epoch: number }) => e.epoch)).toEqual([43, 42]);
    expect(first.nextCursor).not.toBeNull();
    const second = await (await fetch(srv.url + `${BASE}/epochs?limit=2&cursor=${first.nextCursor}`)).json();
    expect(second.items.map((e: { epoch: number }) => e.epoch)).toEqual([41, 40]);
    expect(second.nextCursor).toBeNull();
  });

  it("TC-BE-014-14 circle does not exist", async () => {
    const res = await fetch(srv.url + "/x207/circles/nope/epochs");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("circle_not_found");
  });
});
