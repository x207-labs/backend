import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/index.js";
import type { SourceBlock } from "../../src/indexer/block-source.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { ArrayBlockSource, CONTRACT, DEFAULT_PARAMS, fxLog42 } from "./fx-log42.js";
import { listen, type TestServer } from "./d9-fixtures.js";

/** D9 hasil indexer `FX-LOG42` sampai blok ke-`upTo` (11 = seluruh skenario), dilayani oleh read API. */
export async function fxServer(
  upTo = 11,
  extra: SourceBlock[] = [],
  now?: () => number,
): Promise<{ db: Database.Database; srv: TestServer; close: () => Promise<void> }> {
  const db = openDatabase(":memory:");
  const source = new ArrayBlockSource([...fxLog42().slice(0, upTo), ...extra]);
  const ix = new Indexer({ db, source, circleId: "agents-main", contractId: CONTRACT, startBlock: 1000,
    fetchParams: () => Promise.resolve(DEFAULT_PARAMS as never) });
  await ix.bootstrap();
  await ix.drain();
  const srv = await listen({ db, ...(now ? { now } : {}) });
  return { db, srv, close: async () => {
      await srv.close();
      db.close();
    },
  };
}
