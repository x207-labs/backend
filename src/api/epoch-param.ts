import { ApiError, invalidRequest } from "./errors.js";
import { row } from "./format.js";
import type { RouteContext } from "./router.js";
import type { EpochRow } from "./routes/epochs.js";

const EPOCH_COLUMNS = `epoch, phase, cutoff_at_ns, closed_at_ns, proposal_deadline_ns, committed_at_ns,
  payment_deadline_ns, finalized_at_ns, edge_count, total_obligation, cleared_total`;

/** `{n}` = bilangan bulat ≥ 0 atau `current` (epoch terbesar di D9); 404 `epoch_not_found` bila belum ada. */
export function resolveEpoch(ctx: Pick<RouteContext, "db" | "circle" | "params">): EpochRow {
  const raw = ctx.params.n as string;
  if (raw !== "current" && !/^\d+$/.test(raw)) throw invalidRequest("{n} harus bilangan bulat >= 0 atau current", { n: raw });
  const found =
    raw === "current"
      ? row<EpochRow>(ctx.db, `SELECT ${EPOCH_COLUMNS} FROM epochs WHERE circle_id = ? ORDER BY epoch DESC LIMIT 1`, ctx.circle.circle_id)
      : row<EpochRow>(ctx.db, `SELECT ${EPOCH_COLUMNS} FROM epochs WHERE circle_id = ? AND epoch = ?`, ctx.circle.circle_id, BigInt(raw));
  if (!found) {
    throw new ApiError(404, "epoch_not_found", `Epoch ${raw} belum ada di D9`, {
      circle: ctx.circle.circle_id,
      epoch: raw === "current" ? raw : Number(raw),
    });
  }
  return found;
}
