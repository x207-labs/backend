// Epoch `open` untuk bundle marketplace. Sumber utama adalah view `get_epoch` kontrak (benar sejak blok pertama dan tidak menunggu indexer);
// bila view tidak diberikan atau gagal, baris `epochs` D9 yang dipakai. Baris D9 baru ada setelah voucher pertama atau `close_epoch`, jadi
// tanpa view buku menolak bundle di epoch pertama.
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
        // RPC tidak tersedia: jatuh ke D9
      }
    }
    return d9OpenEpoch(db, circle.circle_id);
  };
}
