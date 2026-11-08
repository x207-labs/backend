import { ApiError, invalidRequest } from "./errors.js";
import { row } from "./format.js";
import type { RouteContext } from "./router.js";
import type { EpochRow } from "./routes/epochs.js";

const EPOCH_COLUMNS = `epoch, phase, cutoff_at_ns, closed_at_ns, proposal_deadline_ns, committed_at_ns,
  payment_deadline_ns, finalized_at_ns, edge_count, total_obligation, cleared_total`;

/** A-BE-03: SQLite stores int64; a longer number cannot exist and must not reach the driver (it throws a RangeError = 500). */
export const MAX_INT64 = 9223372036854775807n;

/** `raw` is a decimal integer (digits only, no leading zero except `0`) that fits in int64; else `400 invalid_request` named `field`. */
export function parseInt64Param(raw: string, field: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(raw) || raw.length > 19 || BigInt(raw) > MAX_INT64) {
    throw invalidRequest(`${field} must be an integer between 0 and ${MAX_INT64}`, { [field]: raw });
  }
  return BigInt(raw);
}

/** `{n}` = integer ≥ 0 or `current` (the largest epoch in D9); 404 `epoch_not_found` if it does not exist yet. */
export function resolveEpoch(ctx: Pick<RouteContext, "db" | "circle" | "params">): EpochRow {
  const raw = ctx.params.n as string;
  if (raw !== "current" && !/^\d+$/.test(raw)) throw invalidRequest("{n} must be an integer >= 0 or current", { n: raw });
  const n = raw === "current" ? undefined : parseInt64Param(raw, "n");
  const found =
    raw === "current"
      ? row<EpochRow>(ctx.db, `SELECT ${EPOCH_COLUMNS} FROM epochs WHERE circle_id = ? ORDER BY epoch DESC LIMIT 1`, ctx.circle.circle_id)
      : row<EpochRow>(ctx.db, `SELECT ${EPOCH_COLUMNS} FROM epochs WHERE circle_id = ? AND epoch = ?`, ctx.circle.circle_id, n);
  if (!found) {
    throw new ApiError(404, "epoch_not_found", `Epoch ${raw} does not exist in D9 yet`, {
      circle: ctx.circle.circle_id,
      epoch: raw === "current" ? raw : Number(raw),
    });
  }
  return found;
}
