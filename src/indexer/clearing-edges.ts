// BE-077: the cleared edges of an epoch. In interface 0.0.13 `clearing_applied` is a summary (`edge_count`, `edges_hash`) and the edges are read from the view
// `list_obligations` after the event. `cleared` does not change after the commit, so the view of the final block is the same data as at the event.
// The edges are read BEFORE the block is applied (the handlers are synchronous inside the SQLite transaction), checked against `edges_hash`, and kept in `clearing_edges`.
// That table is not part of the read model: a rebuild replays `clearing_applied` from it, with no RPC.
import type Database from "better-sqlite3";
import { EVENT_PREFIX } from "@x207/core";
import type { SourceBlock } from "./block-source.js";
import { clearingHashes, type ClearedEdge } from "./clearing-hashes.js";
import { IndexerHaltError } from "./errors.js";

/** Every obligation of the epoch with its `cleared`, in any order (all pages of `list_obligations`). */
export type FetchClearedEdges = (epoch: number) => Promise<ClearedEdge[]>;

export interface PrefetchOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The epochs of the `clearing_applied` events of the summary form in a block. */
export function appliedSummaries(block: SourceBlock, contractId: string): Array<{ epoch: number; edgesHash: string; edgeCount: number }> {
  const found: Array<{ epoch: number; edgesHash: string; edgeCount: number }> = [];
  for (const log of block.logs) {
    if (log.executorId !== contractId || !log.log.startsWith(EVENT_PREFIX) || !log.log.includes("clearing_applied")) continue;
    let envelope: { standard?: unknown; event?: unknown; data?: unknown };
    try {
      envelope = JSON.parse(log.log.slice(EVENT_PREFIX.length));
    } catch {
      continue; // the indexer halts on this log when it ingests it
    }
    if (envelope.standard !== "x207" || envelope.event !== "clearing_applied") continue;
    for (const d of (Array.isArray(envelope.data) ? envelope.data : [envelope.data]) as Array<Record<string, unknown> | undefined>) {
      if (typeof d?.edges_hash === "string" && typeof d.epoch === "number") found.push({ epoch: d.epoch, edgesHash: d.edges_hash, edgeCount: Number(d.edge_count) });
    }
  }
  return found;
}

export function storedClearingEdges(db: Database.Database, circleId: string, epoch: number): { edges: ClearedEdge[]; edgesHash: string } | undefined {
  const row = db.prepare("SELECT edges_json, edges_hash FROM clearing_edges WHERE circle_id = ? AND epoch = ?").get(circleId, epoch) as { edges_json: string; edges_hash: string } | undefined;
  return row ? { edges: JSON.parse(row.edges_json) as ClearedEdge[], edgesHash: row.edges_hash } : undefined;
}

/**
 * Read, check and keep the edges of each `clearing_applied` summary of the block. A failing view is retried; when it still fails the error goes up as a source error
 * (the cursor does not move and `run` tries the block again with a backoff). A set whose hash is not `edges_hash` is not a source error: the indexer halts.
 */
export async function prefetchClearingEdges(
  db: Database.Database, circleId: string, contractId: string, block: SourceBlock, fetchEdges: FetchClearedEdges | undefined, options: PrefetchOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const s of appliedSummaries(block, contractId)) {
    if (storedClearingEdges(db, circleId, s.epoch)?.edgesHash === s.edgesHash) continue;
    if (!fetchEdges) throw new IndexerHaltError(`clearing_applied epoch ${s.epoch} has its edges in the view list_obligations: the indexer has no way to read it (fetchClearedEdges)`);
    let edges: ClearedEdge[] | undefined;
    let last: unknown;
    for (let attempt = 1; attempt <= attempts && edges === undefined; attempt++) {
      try {
        edges = await fetchEdges(s.epoch);
      } catch (error) {
        last = error;
        if (attempt < attempts) await sleep(delayMs * attempt);
      }
    }
    if (edges === undefined) throw new Error(`list_obligations epoch ${s.epoch} failed ${attempts} times: ${(last as Error)?.message ?? String(last)}`);
    const cleared = edges.filter((e) => BigInt(e.cleared) > 0n).map((e) => ({ debtor: e.debtor, creditor: e.creditor, cleared: e.cleared }));
    const hash = clearingHashes().edgesHash(cleared);
    if (hash !== s.edgesHash || cleared.length !== s.edgeCount) {
      throw new IndexerHaltError(`clearing_applied epoch ${s.epoch}: the edges of list_obligations (${cleared.length}, hash ${hash}) are not the ones of the event (${s.edgeCount}, hash ${s.edgesHash})`);
    }
    db.prepare("INSERT OR REPLACE INTO clearing_edges (circle_id, epoch, edges_json, edges_hash, block_height) VALUES (?, ?, ?, ?, ?)").run(circleId, s.epoch, JSON.stringify(cleared), hash, block.height);
  }
}
