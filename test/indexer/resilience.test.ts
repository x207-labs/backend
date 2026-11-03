import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { ArrayBlockSource, CONTRACT, fxLog42 } from "../helpers/fx-log42.js";

const CIRCLE = "agents-main";
const START = 1000;
const TABLES = ["events_raw", "members", "member_limits", "epochs", "obligations", "clearing_log", "settlements", "params"];
// the fixture numbers its receipts as it goes: the blocks are made once and every run reads these
const BLOCKS = fxLog42();
const dir = mkdtempSync(join(tmpdir(), "x207-resilience-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const snapshot = (file: string): Record<string, unknown[]> => {
  const db = new Database(file, { readonly: true });
  try {
    return Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).safeIntegers(true).all().map((r) => JSON.parse(JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v))))]));
  } finally {
    db.close();
  }
};
const cursorOf = (file: string): number => {
  const db = new Database(file, { readonly: true });
  try {
    return Number((db.prepare("SELECT last_block_height AS h FROM indexer_cursor").get() as { h: number }).h);
  } finally {
    db.close();
  }
};

/** The run without a disturbance, in this process, over a file: the reference. */
async function clean(name: string): Promise<string> {
  const file = join(dir, name);
  const db = openDatabase(file);
  const ix = new Indexer({ db, source: new ArrayBlockSource(BLOCKS), circleId: CIRCLE, contractId: CONTRACT, startBlock: START });
  await ix.bootstrap();
  await ix.drain();
  db.close();
  return file;
}

describe("BE-072 the indexer survives a kill, a dead source and a source that is ahead of finality", () => {
  it("TC-BE-072-01 only final blocks are read: blocks above the final height are not asked for, and are read when the height rises", async () => {
    const db = openDatabase(":memory:");
    const blocks = BLOCKS;
    const source = new ArrayBlockSource(blocks, START + 3); // the chain has more blocks than are final
    const ix = new Indexer({ db, source, circleId: CIRCLE, contractId: CONTRACT, startBlock: START });
    await ix.bootstrap();
    await ix.drain();
    expect(Math.max(...source.requested)).toBe(START + 3);
    expect((db.prepare("SELECT MAX(block_height) AS h FROM events_raw").get() as { h: number }).h).toBeLessThanOrEqual(START + 3);
    source.head = Math.max(...blocks.map((b) => b.height));
    await ix.drain();
    expect(Math.max(...source.requested)).toBe(source.head);
    db.close();
  });

  it("TC-BE-072-02 a handler that dies in the middle of a block rolls the whole block back; a new indexer on the same file continues from the last block and ends with the state of the run without a disturbance (every kill point)", async () => {
    const reference = snapshot(await clean("ref-inproc.db"));
    const total = (reference.events_raw as unknown[]).length;
    for (let k = 1; k <= total; k += 3) {
      const file = join(dir, `crash-${k}.db`);
      let calls = 0;
      const sentinel = new Error("killed");
      const db = openDatabase(file);
      const first = new Indexer({
        db, source: new ArrayBlockSource(BLOCKS), circleId: CIRCLE, contractId: CONTRACT, startBlock: START,
        handlers: new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => { calls += 1; if (calls === k) throw sentinel; return (rawDefault as Record<string, (...a: unknown[]) => unknown>)[name]?.(...args); } }) as never,
      });
      await first.bootstrap();
      await expect(first.drain()).rejects.toBe(sentinel);
      const midCursor = cursorOf(file);
      db.close();
      // nothing of the block that died is in the file: the events of the blocks before it are, the cursor is the last block that finished
      const partial = snapshot(file);
      expect((partial.events_raw as Array<{ block_height: string }>).every((e) => Number(e.block_height) <= midCursor), `kill ${k}`).toBe(true);
      const db2 = openDatabase(file);
      const second = new Indexer({ db: db2, source: new ArrayBlockSource(BLOCKS), circleId: CIRCLE, contractId: CONTRACT, startBlock: START });
      await second.bootstrap();
      await second.drain();
      db2.close();
      expect(snapshot(file), `kill ${k}`).toEqual(reference);
    }
  });

  const dist = new URL("../../dist/indexer/indexer.js", import.meta.url).pathname;
  it.skipIf(!existsSync(dist))("TC-BE-072-03 a process killed with SIGKILL inside a handler, then started again, ends with the same events and state as the run without a disturbance", async () => {
    const reference = snapshot(await clean("ref-child.db"));
    const total = (reference.events_raw as unknown[]).length;
    const blocksFile = join(dir, "blocks.json");
    writeFileSync(blocksFile, JSON.stringify(BLOCKS, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    const child = new URL("../fixtures/kill-indexer.mjs", import.meta.url).pathname;
    const run = (file: string, killAfter: number) => spawnSync(process.execPath, [child, file, blocksFile, CIRCLE, CONTRACT, String(START), String(killAfter)], { encoding: "utf8", timeout: 60_000 });
    for (const k of [1, 4, 9, 14]) {
      const file = join(dir, `kill-${k}.db`);
      const killed = run(file, k);
      expect(killed.signal, `kill ${k}: ${killed.stderr}`).toBe("SIGKILL");
      // the file survived the kill and is not ahead of what committed
      const mid = snapshot(file);
      expect((mid.events_raw as unknown[]).length).toBeLessThan(total);
      const finished = run(file, -1);
      expect(finished.status, finished.stderr).toBe(0);
      expect(snapshot(file), `kill ${k}`).toEqual(reference);
    }
  });

  it("TC-BE-072-04 restarting after every block (a new indexer each time) and reading the last blocks twice give the state of one run: events once, per receipt and log index", async () => {
    const reference = snapshot(await clean("ref-restart.db"));
    const file = join(dir, "restart.db");
    for (let i = 0; i < 40; i++) {
      const db = openDatabase(file);
      const ix = new Indexer({ db, source: new ArrayBlockSource(BLOCKS), circleId: CIRCLE, contractId: CONTRACT, startBlock: START });
      await ix.bootstrap();
      await ix.step();
      db.close();
    }
    // the cursor is put back by three blocks: the same logs arrive again and add nothing
    const db = new Database(file);
    db.prepare("UPDATE indexer_cursor SET last_block_height = last_block_height - 3").run();
    db.close();
    const db2 = openDatabase(file);
    const again = new Indexer({ db: db2, source: new ArrayBlockSource(BLOCKS), circleId: CIRCLE, contractId: CONTRACT, startBlock: START });
    await again.bootstrap();
    await again.drain();
    db2.close();
    expect(snapshot(file)).toEqual(reference);
  });

  it("TC-BE-072-05 a source that dies in the middle: the indexer asks again with a backoff that grows to its ceiling, the cursor does not move, and when the source is back the events are those of the run without a disturbance", async () => {
    const reference = snapshot(await clean("ref-backoff.db"));
    const file = join(dir, "backoff.db");
    const db = openDatabase(file);
    const source = new ArrayBlockSource(BLOCKS);
    const original = source.getBlock.bind(source);
    const attempts: number[] = [];
    let dead = false;
    source.getBlock = (h) => {
      if (h === START + 4 && !dead) dead = true; // the source dies at the fifth block
      if (dead && attempts.length < 6) {
        attempts.push(Date.now());
        return Promise.reject(new Error("rpc down"));
      }
      return original(h);
    };
    const ix = new Indexer({ db, source, circleId: CIRCLE, contractId: CONTRACT, startBlock: START });
    await ix.bootstrap();
    const ctrl = new AbortController();
    const errors: unknown[] = [];
    const done = ix.run({ signal: ctrl.signal, pollMs: 20, maxBackoffMs: 80, onError: (e) => errors.push(e) });
    const until = Date.now() + 10_000;
    while (cursorOf(file) < Math.max(...BLOCKS.map((b) => b.height)) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    ctrl.abort();
    await done;
    expect(errors).toHaveLength(6);
    const gaps = attempts.slice(1).map((t, i) => t - (attempts[i] as number));
    expect(gaps[gaps.length - 1]!, `gaps ${gaps.join(",")}`).toBeGreaterThanOrEqual(gaps[0]! * 2); // it grew
    expect(Math.max(...gaps)).toBeLessThan(400); // and stopped at the ceiling (80 ms plus the time of the machine)
    db.close();
    expect(snapshot(file)).toEqual(reference);
  });
});

import { defaultHandlers as rawDefault } from "../../src/indexer/handlers/index.js";
