// The `open` epoch for marketplace bundles. The main source is the contract's `get_epoch` view (correct from the first block and does not wait for the indexer);
// if the view is not given or fails, the D9 `epochs` row is used. The D9 row only exists after the first voucher or `close_epoch`, so
// without the view the book rejects bundles in the first epoch.
import type Database from "better-sqlite3";
import { row } from "../api/format.js";
import type { ViewFunction } from "../settlement/intents.js";

export type OpenEpochResolver = (db: Database.Database, circle: { circle_id: string; contract_id: string }) => Promise<number | null>;

export function d9OpenEpoch(db: Database.Database, circleId: string): number | null {
  const open = row<{ epoch: bigint }>(db, "SELECT epoch FROM epochs WHERE circle_id = ? AND phase = 'open' ORDER BY epoch DESC LIMIT 1", circleId);
  return open ? Number(open.epoch) : null;
}

export function openEpochResolver(view?: ViewFunction): OpenEpochResolver {
  return async (db, circle) => {
    if (view) {
      try {
        const epoch = (await view(circle.contract_id, "get_epoch", {})) as { epoch?: unknown; phase?: unknown } | null;
        if (epoch && Number.isSafeInteger(epoch.epoch)) return epoch.phase === "open" ? (epoch.epoch as number) : null;
      } catch {
        // RPC not available: fall back to D9
      }
    }
    return d9OpenEpoch(db, circle.circle_id);
  };
}
