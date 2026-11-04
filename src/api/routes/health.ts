import { ApiError } from "../errors.js";
import { isoFromMs, rows } from "../format.js";
import type { Route } from "../router.js";

/** `status` becomes `degraded` when the lag exceeds this threshold (Spec API Backend 3.1). */
export const DEGRADED_LAG_BLOCKS = 100;

interface CursorRow {
  name: string;
  last_block_height: bigint;
  head_block_height: bigint;
  lag_blocks: bigint;
  rpc_endpoint: string;
  updated_at: bigint;
}

/** `GET /x207/health` (Spec API Backend 3.1): indexer lag per contract. */
export const healthRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/health",
    circleScoped: false,
    handler: ({ db }) => {
      let cursors: CursorRow[] = [];
      try {
        cursors = rows<CursorRow>(
          db,
          "SELECT name, last_block_height, head_block_height, lag_blocks, rpc_endpoint, updated_at FROM indexer_cursor ORDER BY name",
        );
      } catch {
        // table not migrated yet: treated the same as a cursor that does not exist
      }
      if (cursors.length === 0) throw new ApiError(503, "indexer_unavailable", "Indexer has not bootstrapped yet");
      return {
        status: 200,
        body: {
          status: cursors.some((c) => c.lag_blocks > BigInt(DEGRADED_LAG_BLOCKS)) ? "degraded" : "ok",
          cursors: cursors.map((c) => ({
            name: c.name,
            lastBlockHeight: Number(c.last_block_height),
            headBlockHeight: Number(c.head_block_height),
            lagBlocks: Number(c.lag_blocks),
            rpcEndpoint: c.rpc_endpoint,
            updatedAt: isoFromMs(Number(c.updated_at)),
          })),
        },
      };
    },
  },
];
