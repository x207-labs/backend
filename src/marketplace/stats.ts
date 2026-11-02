// Statistik marketplace (BE-043, F9): `GET /x207/circles/{circle}/marketplace/stats`.
// Semua angka dihitung dari baris listings/offers/matches/intents saat diminta; tidak ada nilai contoh.
// `searcherRevenue` = jatah pencari dari kecocokan yang disepakati (leg bundle); klaim on-chain `solver_fee` diurus M10 terpisah.
import { row, rows } from "../api/format.js";
import type { Route } from "../api/router.js";
import { nowSeconds } from "./common.js";

function count(db: Parameters<typeof row>[0], sql: string, ...args: unknown[]): number {
  const found = row<{ n: bigint }>(db, sql, ...args);
  return found ? Number(found.n) : 0;
}

const sum = (values: readonly string[]): bigint => values.reduce((total, v) => total + BigInt(v), 0n);

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

export const statsRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/marketplace/stats",
    circleScoped: true,
    handler: ({ db, circle, now }) => {
      const nowS = nowSeconds(now());
      const id = circle.circle_id;
      const listings = {
        open: count(db, "SELECT COUNT(*) AS n FROM listings WHERE circle_id = ? AND status = 'open' AND expires_at > ?", id, nowS),
        matched: count(db, "SELECT COUNT(*) AS n FROM listings WHERE circle_id = ? AND status = 'matched'", id),
        cancelled: count(db, "SELECT COUNT(*) AS n FROM listings WHERE circle_id = ? AND status = 'cancelled'", id),
        expired: count(db, "SELECT COUNT(*) AS n FROM listings WHERE circle_id = ? AND status = 'open' AND expires_at <= ?", id, nowS),
        total: count(db, "SELECT COUNT(*) AS n FROM listings WHERE circle_id = ?", id),
      };
      const openByClass = Object.fromEntries(
        rows<{ cls: string; n: bigint }>(
          db,
          "SELECT offer_class AS cls, COUNT(*) AS n FROM listings WHERE circle_id = ? AND status = 'open' AND expires_at > ? GROUP BY offer_class ORDER BY offer_class",
          id,
          nowS,
        ).map((r) => [r.cls, Number(r.n)]),
      );

      const matches = rows<{ kind: string; mode: string; listing_value: string; discount_value: string; searcher_account: string | null; searcher_value: string; wait_ms: bigint }>(
        db,
        `SELECT m.kind, m.mode, m.listing_value, m.discount_value, m.searcher_account, m.searcher_value, (m.matched_at_ms - l.created_at_ms) AS wait_ms
         FROM matches m JOIN listings l ON l.circle_id = m.circle_id AND l.listing_hash = m.listing_hash WHERE m.circle_id = ?`,
        id,
      );
      const waits = matches.map((m) => Math.max(0, Math.round(Number(m.wait_ms) / 1000))).sort((a, b) => a - b);
      const bySearcher = new Map<string, bigint>();
      for (const m of matches) {
        if (m.searcher_account !== null) bySearcher.set(m.searcher_account, (bySearcher.get(m.searcher_account) ?? 0n) + BigInt(m.searcher_value));
      }
      const matched = {
        count: matches.length,
        payment: matches.filter((m) => m.kind === "payment").length,
        bundle: matches.filter((m) => m.kind === "bundle").length,
        pay: matches.filter((m) => m.mode === "pay").length,
        barter: matches.filter((m) => m.mode === "barter").length,
        listingValue: sum(matches.map((m) => m.listing_value)).toString(),
        discountValue: sum(matches.map((m) => m.discount_value)).toString(),
      };
      return {
        status: 200,
        body: {
          circle: id,
          listings,
          openListingsByOfferClass: openByClass,
          intentsOpen: count(db, "SELECT COUNT(*) AS n FROM intents WHERE circle_id = ? AND status = 'open' AND expires_at > ?", id, nowS),
          offersPending: count(db, "SELECT COUNT(*) AS n FROM offers WHERE circle_id = ? AND status = 'pending'", id),
          bundleProposals: {
            proposed: count(db, "SELECT COUNT(*) AS n FROM bundle_proposals WHERE circle_id = ? AND status = 'proposed'", id),
            ready: count(db, "SELECT COUNT(*) AS n FROM bundle_proposals WHERE circle_id = ? AND status = 'ready'", id),
          },
          matches: matched,
          timeToMatchSeconds: {
            samples: waits.length,
            min: waits[0] ?? null,
            max: waits[waits.length - 1] ?? null,
            average: waits.length === 0 ? null : Math.round(waits.reduce((a, b) => a + b, 0) / waits.length),
            median: median(waits),
          },
          searcherRevenue: {
            total: sum(matches.map((m) => m.searcher_value)).toString(),
            matchesWithSearcher: matches.filter((m) => m.searcher_account !== null).length,
            bySearcher: [...bySearcher.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([account, total]) => ({ account, total: total.toString() })),
          },
          unit: "credit",
          decimals: 6,
        },
      };
    },
  },
];
