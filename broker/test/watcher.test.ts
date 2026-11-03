import { describe, expect, it } from "vitest";
import { BrokerStore } from "../src/store.js";
import { cursorOf, GrantWatcher, type WatchedEvent } from "../src/watcher/index.js";

const ev = (h: number, name: string, data: Record<string, unknown>, receipt = `r${h}`, i = 0): WatchedEvent => ({ receiptId: receipt, logIndex: i, blockHeight: h, event: name, data });

/** A read API over a list: serves the events after the cursor, as the real one does. */
function readApi(log: WatchedEvent[]) {
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = new URL(String(input));
    requests.push(url.search);
    const names = (url.searchParams.get("event") ?? "").split(",");
    const cursor = url.searchParams.get("cursor");
    const after = cursor ? (JSON.parse(Buffer.from(cursor, "base64url").toString()) as { h: number; r: string; i: number }) : { h: -1, r: "", i: -1 };
    const limit = Number(url.searchParams.get("limit"));
    const all = log.filter((e) => names.includes(e.event) && (e.blockHeight > after.h || (e.blockHeight === after.h && (e.receiptId > after.r || (e.receiptId === after.r && e.logIndex > after.i)))));
    return new Response(JSON.stringify({ items: all.slice(0, limit), more: all.length > limit }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

describe("BK-003 watcher", () => {
  const log = [
    ev(10, "grant_activated", { grant_id: 1 }),
    ev(11, "member_defaulted", { account_id: "d.near" }),
    ev(12, "grant_revoked", { grant_id: 1, reason: "defaulted" }),
    ev(12, "grant_offered", { grant_id: 2 }, "r12", 1),
  ];

  it("TC-BK-003-01 handles the watched events in order, over several pages, and ignores the others", async () => {
    const store = new BrokerStore(":memory:");
    const { fetchFn } = readApi(log);
    const seen: string[] = [];
    const watcher = new GrantWatcher({ readApiUrl: "http://api", circle: "agents-main", store, fetch: fetchFn, pageSize: 2 });
    expect(await watcher.poll((e) => void seen.push(`${e.event}:${e.blockHeight}`))).toBe(3);
    expect(seen).toEqual(["grant_activated:10", "member_defaulted:11", "grant_revoked:12"]);
    expect(await watcher.poll((e) => void seen.push(e.event))).toBe(0);
    expect(store.cursor("events")).toBe(cursorOf(log[2]!));
  });

  it("TC-BK-003-02 after a restart it continues from the stored cursor and handles nothing twice", async () => {
    const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "broker-"));
    const path = `${dir}/b.db`;
    const first = new BrokerStore(path);
    const api = readApi(log.slice(0, 2));
    const seen: number[] = [];
    await new GrantWatcher({ readApiUrl: "http://api", circle: "c", store: first, fetch: api.fetchFn }).poll((e) => void seen.push(e.blockHeight));
    first.close();
    const second = new BrokerStore(path);
    const later = readApi(log);
    await new GrantWatcher({ readApiUrl: "http://api", circle: "c", store: second, fetch: later.fetchFn }).poll((e) => void seen.push(e.blockHeight));
    expect(seen).toEqual([10, 11, 12]);
    // the second run asked for events after the stored position, not from the beginning
    expect(later.requests[0]).toContain("cursor=");
  });

  it("TC-BK-003-03 an event that the read API sends again is handled once (receipt_id and log_index)", async () => {
    const store = new BrokerStore(":memory:");
    const duplicate = [log[0]!, { ...log[0]! }];
    const { fetchFn } = readApi(duplicate);
    const seen: number[] = [];
    expect(await new GrantWatcher({ readApiUrl: "http://api", circle: "c", store, fetch: fetchFn }).poll((e) => void seen.push(e.blockHeight))).toBe(1);
    expect(seen).toEqual([10]);
  });

  it("TC-BK-003-04 a handler that fails is logged and its event skipped, the events behind it are still handled", async () => {
    const store = new BrokerStore(":memory:");
    const { fetchFn } = readApi(log);
    const lines: string[] = [];
    const watcher = new GrantWatcher({ readApiUrl: "http://api", circle: "c", store, fetch: fetchFn, log: (l) => lines.push(l) });
    const seen: string[] = [];
    const handler = (e: WatchedEvent) => {
      if (e.event === "member_defaulted") throw new Error("chain down");
      seen.push(e.event);
    };
    await watcher.poll(handler);
    expect(seen).toEqual(["grant_activated", "grant_revoked"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("member_defaulted");
    expect(lines[0]).toContain("chain down");
    expect(await watcher.poll(handler)).toBe(0);
    expect(seen).toEqual(["grant_activated", "grant_revoked"]);
  });

  it("TC-BK-003-05 a read API that answers an error stops the poll without moving the cursor", async () => {
    const store = new BrokerStore(":memory:");
    const fetchFn = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    await expect(new GrantWatcher({ readApiUrl: "http://api", circle: "c", store, fetch: fetchFn }).poll(() => {})).rejects.toThrow(/503/);
    expect(store.cursor("events")).toBeUndefined();
  });
});
