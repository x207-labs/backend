import { invalidRequest } from "../errors.js";
import { row, rows } from "../format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import type { Route } from "../router.js";

interface ParamRow {
  id: bigint;
  field: string;
  old_value: string | null;
  new_value: string;
  effective_epoch: bigint;
  block_height: bigint;
}

const json = (text: string | null): unknown => (text === null ? null : (JSON.parse(text) as unknown));

/** BE-017: parameter aktif dan riwayat perubahan (Spec API Backend 3.5, Spec Skema D9 6.7). */
export const paramRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/params",
    circleScoped: true,
    handler: ({ db, circle }) => {
      const current = row<{ epoch: bigint }>(db, "SELECT COALESCE(MAX(epoch), 0) AS epoch FROM epochs WHERE circle_id = ?", circle.circle_id)?.epoch ?? 0n;
      // Nilai terbaru per field; yang `effective_epoch`-nya belum tiba adalah perubahan tertunda.
      const latest = rows<ParamRow>(
        db,
        `SELECT id, field, old_value, new_value, effective_epoch, block_height FROM params p
         WHERE circle_id = ? AND effective_epoch <= ? AND id = (
           SELECT MAX(id) FROM params q WHERE q.circle_id = p.circle_id AND q.field = p.field AND q.effective_epoch <= ?)`,
        circle.circle_id, current, current,
      );
      const pending = rows<ParamRow>(
        db,
        `SELECT id, field, old_value, new_value, effective_epoch, block_height FROM params p
         WHERE circle_id = ? AND effective_epoch > ? AND id = (
           SELECT MAX(id) FROM params q WHERE q.circle_id = p.circle_id AND q.field = p.field AND q.effective_epoch > ?)
         ORDER BY effective_epoch, id`,
        circle.circle_id, current, current,
      );
      const first = pending[0];
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          currentEpoch: Number(current),
          active: Object.fromEntries(latest.map((p) => [p.field, json(p.new_value)])),
          nextEpoch: first ? Object.fromEntries(pending.map((p) => [p.field, json(p.new_value)])) : null,
          nextEpochEffective: first ? Number(first.effective_epoch) : null,
        },
      };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/params/history",
    circleScoped: true,
    handler: ({ db, circle, query }) => {
      const limit = parseLimit(query);
      const cursor = decodeCursor(query);
      const before = cursor && typeof cursor.a === "number" ? cursor.a : null;
      if (cursor && before === null) throw invalidRequest("invalid cursor");
      const found = rows<ParamRow>(
        db,
        `SELECT id, field, old_value, new_value, effective_epoch, block_height FROM params
         WHERE circle_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
        circle.circle_id, before, before, limit + 1,
      );
      const page = found.slice(0, limit);
      const last = page[page.length - 1];
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          items: page.map((p) => ({
            id: Number(p.id),
            field: p.field,
            oldValue: json(p.old_value),
            newValue: json(p.new_value),
            effectiveEpoch: Number(p.effective_epoch),
            blockHeight: Number(p.block_height),
          })),
          nextCursor: found.length > limit && last ? encodeCursor({ a: Number(last.id) }) : null,
        },
      };
    },
  },
];
