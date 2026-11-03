import { invalidRequest } from "../errors.js";
import { rows } from "../format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import type { Route } from "../router.js";

interface EventRow {
  receipt_id: string;
  log_index: bigint;
  block_height: bigint;
  block_timestamp_ns: bigint;
  tx_hash: string | null;
  event: string;
  data_json: string;
}

const NAME = /^[a-z_]{1,64}$/;

/**
 * BK-003: `GET /x207/circles/{circle}/events?event=a,b&cursor=…`, the contract events in the order they happened
 * (block, receipt, log index), for consumers such as the access broker that must not miss or repeat one. `event` filters by name.
 * `nextCursor` is the position after the last event shown; `null` when the page reaches the end of what is indexed so far,
 * and a consumer that polls keeps the cursor of the last event it handled.
 */
export const eventRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/events",
    circleScoped: true,
    handler: ({ db, circle, query }) => {
      const names = (query.get("event") ?? "").split(",").filter((n) => n !== "");
      for (const n of names) if (!NAME.test(n)) throw invalidRequest("invalid event name", { event: n });
      const limit = parseLimit(query);
      const cursor = decodeCursor(query) as { h?: number; r?: string; i?: number } | null;
      const h = cursor?.h ?? -1;
      const r = cursor?.r ?? "";
      const i = cursor?.i ?? -1;
      const page = rows<EventRow>(
        db,
        `SELECT receipt_id, log_index, block_height, block_timestamp_ns, tx_hash, event, data_json FROM events_raw
         WHERE contract_id = ? AND (block_height > ? OR (block_height = ? AND (receipt_id > ? OR (receipt_id = ? AND log_index > ?))))
           ${names.length === 0 ? "" : `AND event IN (${names.map(() => "?").join(",")})`}
         ORDER BY block_height, receipt_id, log_index LIMIT ?`,
        circle.contract_id, h, h, r, r, i, ...names, limit + 1,
      );
      const more = page.length > limit;
      const shown = more ? page.slice(0, limit) : page;
      const last = shown[shown.length - 1];
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          items: shown.map((e) => ({
            receiptId: e.receipt_id,
            logIndex: Number(e.log_index),
            blockHeight: Number(e.block_height),
            blockTimestampNs: e.block_timestamp_ns.toString(),
            txHash: e.tx_hash,
            event: e.event,
            data: (JSON.parse(e.data_json) as unknown[])[0] ?? null,
          })),
          nextCursor: last === undefined ? null : encodeCursor({ h: Number(last.block_height), r: last.receipt_id, i: Number(last.log_index) }),
          more,
        },
      };
    },
  },
];
