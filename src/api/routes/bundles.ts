import { invalidRequest } from "../errors.js";
import { amount, DECIMALS, rows, UNIT } from "../format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../pagination.js";
import type { Route } from "../router.js";

const STATUSES = ["active"] as const;

interface BundleRow {
  bundle_id: bigint;
  terms_hash: string;
  epoch: bigint;
  solver: string;
  status: string;
  block_height: bigint;
}

interface LegRow {
  bundle_id: bigint;
  payer: string;
  payee: string;
  max_amount: string;
}

/** BE-036: `GET /x207/circles/{circle}/bundles?status=active`, bundles committed on chain with their legs (Spec API Backend 3.5). */
export const bundleRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/bundles",
    circleScoped: true,
    handler: ({ db, circle, query }) => {
      const status = query.get("status") ?? "active";
      if (!(STATUSES as readonly string[]).includes(status)) throw invalidRequest("unknown status", { status, allowed: STATUSES });
      const limit = parseLimit(query);
      const cursor = decodeCursor(query);
      const after = cursor === null ? Number.MAX_SAFE_INTEGER : Number((cursor as { id?: number }).id ?? Number.MAX_SAFE_INTEGER);
      const page = rows<BundleRow>(
        db,
        `SELECT bundle_id, terms_hash, epoch, solver, status, block_height FROM bundles
         WHERE circle_id = ? AND status = ? AND bundle_id < ? ORDER BY bundle_id DESC LIMIT ?`,
        circle.circle_id, status, after, limit + 1,
      );
      const more = page.length > limit;
      const shown = more ? page.slice(0, limit) : page;
      const legs = shown.length === 0 ? [] : rows<LegRow>(
        db,
        `SELECT bundle_id, payer, payee, max_amount FROM bundle_legs WHERE circle_id = ? AND bundle_id IN (${shown.map(() => "?").join(",")})
         ORDER BY bundle_id, leg_index`,
        circle.circle_id, ...shown.map((b) => b.bundle_id),
      );
      return {
        status: 200,
        body: {
          circle: circle.circle_id,
          unit: UNIT,
          decimals: DECIMALS,
          items: shown.map((b) => ({
            bundleId: Number(b.bundle_id),
            termsHash: b.terms_hash,
            epoch: Number(b.epoch),
            solver: b.solver,
            status: b.status,
            committedBlock: Number(b.block_height),
            legs: legs.filter((l) => l.bundle_id === b.bundle_id).map((l) => ({ payer: l.payer, payee: l.payee, maxAmount: amount(BigInt(l.max_amount)) })),
          })),
          nextCursor: more ? encodeCursor({ id: Number(shown[shown.length - 1]!.bundle_id) }) : null,
        },
      };
    },
  },
];
