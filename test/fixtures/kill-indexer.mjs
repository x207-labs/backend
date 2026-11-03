// Child process of test/indexer/resilience.test.ts (BE-072): runs the real indexer (the built dist) over a file database and, when asked, kills itself with SIGKILL in the middle of a block
// (inside a handler, so inside the transaction of that block). Usage: node kill-indexer.mjs <db file> <blocks json> <circle> <contract> <start block> <kill after n handler calls or -1>
import { readFileSync } from "node:fs";
import { openDatabase } from "../../dist/db/index.js";
import { Indexer } from "../../dist/indexer/indexer.js";
import { defaultHandlers } from "../../dist/indexer/handlers/index.js";

const [dbFile, blocksFile, circle, contract, start, killAfter] = process.argv.slice(2);
const blocks = JSON.parse(readFileSync(blocksFile, "utf8")).map((b) => ({ ...b, timestampNs: BigInt(b.timestampNs) }));
const head = Math.max(...blocks.map((b) => b.height));
const source = { endpoint: "mock://child", finalHeight: async () => head, getBlock: async (h) => blocks.find((b) => b.height === h) ?? null };
let calls = 0;
const handlers = Object.fromEntries(
  Object.entries(defaultHandlers).map(([name, fn]) => [name, (ctx, e) => {
    fn(ctx, e);
    calls += 1;
    if (Number(killAfter) >= 0 && calls === Number(killAfter)) process.kill(process.pid, "SIGKILL"); // after the write of the handler, before the commit of the block
  }]),
);
const db = openDatabase(dbFile);
const indexer = new Indexer({ db, source, circleId: circle, contractId: contract, startBlock: Number(start), handlers });
await indexer.bootstrap();
await indexer.drain();
db.close();
