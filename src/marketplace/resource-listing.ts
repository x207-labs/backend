// Listing of a metered resource (BE-050, pipeline P5, class D): an endpoint that is paid per unit of use. The listing says the unit, the price of one unit and the
// endpoint, as flat JSON in `Listing.detail` (the only free field): `{"unit": "GB", "unit_price": "<credit>", "endpoint": "https://…"}`; other keys (a name, a note)
// are not checked. Class D does not go through a grant, so the units here are not the `UNITS` of the contract. The statistics per unit are computed from the open
// listings when asked.
import type { Listing } from "@x207/core";
import { ApiError, invalidRequest } from "../api/errors.js";
import { rows } from "../api/format.js";
import type { Route } from "../api/router.js";
import { nowSeconds } from "./common.js";
import type { ListingCheck } from "./listings.js";

export const RESOURCE_UNITS = ["call", "minute", "day", "GB", "job", "request"] as const;
export type ResourceUnit = (typeof RESOURCE_UNITS)[number];

/** The twelve kinds of P5 with their numbers in the barter catalogue (`scripts/lib/asset-catalog.mjs`); a test compares this table with the catalogue. */
export const RESOURCE_ASSET_TYPES: Readonly<Record<string, number>> = {
  "compute:cpu-idle": 31,
  "compute:gpu-hours": 32,
  "storage:capacity": 33,
  "cdn:static-cache": 34,
  "model:inference": 35,
  "model:fine-tuning": 36,
  "oracle:data-feed": 44,
  "iot:sensor-data": 45,
  "gas:relayer": 47,
  "queue:priority-slot": 49,
  "network:proxy-bandwidth": 55,
  "compute:home-device": 90,
};

const U128_MAX = 340282366920938463463374607431768211455n;
const MAX_URL = 512;
/** Query parameters that carry a credential: an endpoint must be reachable by the buyer without a secret in its address. */
const SECRET_PARAM = /^(api[-_]?key|key|token|access[-_]?token|secret|password|passwd|pwd|auth|authorization|signature|sig|credential|session)$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

const invalid = (message: string, details: Record<string, unknown> = {}): never => {
  throw new ApiError(400, "scope_invalid", message, details);
};

/** The reason an endpoint is refused, or `null` when it is an https address without credentials. Pure, for the tests too. */
export function endpointProblem(endpoint: unknown): string | null {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_URL) return `endpoint harus teks 1 sampai ${MAX_URL} karakter`;
  if (!/^[\x21-\x7e]+$/.test(endpoint)) return "endpoint harus ASCII tanpa spasi";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "endpoint bukan URL";
  }
  if (url.protocol !== "https:") return "endpoint harus https";
  if (url.username !== "" || url.password !== "") return "endpoint tidak boleh memuat nama pengguna atau kata sandi";
  if (url.hash !== "") return "endpoint tidak boleh memuat fragmen";
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[") || IPV4.test(host)) return "endpoint harus memakai nama host, bukan alamat IP";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return "endpoint harus nama host publik";
  for (const name of url.searchParams.keys()) if (SECRET_PARAM.test(name)) return `endpoint tidak boleh memuat kredensial di query (${name})`;
  return null;
}

export const resourceCheck: ListingCheck = (listing: Listing) => {
  const offer = (listing as { offer?: { asset_type?: unknown; asset_class?: unknown } }).offer;
  const assetType = offer?.asset_type;
  if (typeof assetType !== "string" || !(assetType in RESOURCE_ASSET_TYPES)) return;
  if (offer?.asset_class !== "D") invalid(`offer.asset_class harus D untuk ${assetType}: sumber daya terukur dibayar per pemakaian`, { assetType, assetClass: offer?.asset_class ?? null });
  let detail: unknown;
  try {
    detail = JSON.parse(String((listing as { detail?: unknown }).detail ?? ""));
  } catch {
    return invalid(`detail untuk ${assetType} harus teks JSON {"unit", "unit_price", "endpoint"}`, { assetType });
  }
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return invalid(`detail untuk ${assetType} harus objek JSON`, { assetType });
  const d = detail as Record<string, unknown>;
  if (!(RESOURCE_UNITS as readonly unknown[]).includes(d.unit)) invalid("unit tidak dikenal", { assetType, unit: d.unit ?? null, allowed: [...RESOURCE_UNITS] });
  if (!(typeof d.unit_price === "string" && /^[1-9]\d*$/.test(d.unit_price) && BigInt(d.unit_price) <= U128_MAX)) {
    invalid("unit_price harus string desimal di atas 0 (credit satuan terkecil per satuan) dan tidak melebihi u128", { assetType });
  }
  const problem = endpointProblem(d.endpoint);
  if (problem !== null) invalid(problem, { assetType });
};

interface ListingDetailRow {
  offer_asset_type: string;
  detail: string;
}

const median = (sorted: readonly bigint[]): bigint => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as bigint) : ((sorted[mid - 1] as bigint) + (sorted[mid] as bigint)) / 2n;
};

export const resourceRoutes: Route[] = [
  {
    // Per unit: how many open listings, which kinds, and the lowest, median and highest price of one unit. Only listings that pass `resourceCheck` count.
    method: "GET",
    pattern: "/x207/circles/{circle}/marketplace/resources/stats",
    circleScoped: true,
    handler: ({ db, circle, query, now }) => {
      const unitFilter = query.get("unit");
      if (unitFilter !== null && !(RESOURCE_UNITS as readonly string[]).includes(unitFilter)) throw invalidRequest("unit tidak dikenal", { unit: unitFilter, allowed: [...RESOURCE_UNITS] });
      const found = rows<ListingDetailRow>(
        db,
        "SELECT offer_asset_type, detail FROM listings WHERE circle_id = ? AND status = 'open' AND expires_at > ? AND offer_class = 'D' ORDER BY id",
        circle.circle_id,
        nowSeconds(now()),
      );
      const byUnit = new Map<string, { prices: bigint[]; types: Set<string> }>();
      for (const r of found) {
        if (!(r.offer_asset_type in RESOURCE_ASSET_TYPES)) continue;
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(r.detail) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (d === null || typeof d !== "object" || !(RESOURCE_UNITS as readonly unknown[]).includes(d.unit) || typeof d.unit_price !== "string" || !/^[1-9]\d*$/.test(d.unit_price)) continue;
        const entry = byUnit.get(d.unit as string) ?? { prices: [], types: new Set<string>() };
        entry.prices.push(BigInt(d.unit_price));
        entry.types.add(r.offer_asset_type);
        byUnit.set(d.unit as string, entry);
      }
      const units = RESOURCE_UNITS.filter((u) => byUnit.has(u) && (unitFilter === null || unitFilter === u)).map((u) => {
        const { prices, types } = byUnit.get(u)!;
        const sorted = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        return {
          unit: u,
          openListings: sorted.length,
          assetTypes: [...types].sort(),
          minUnitPrice: (sorted[0] as bigint).toString(),
          medianUnitPrice: median(sorted).toString(),
          maxUnitPrice: (sorted[sorted.length - 1] as bigint).toString(),
        };
      });
      return { status: 200, body: { circle: circle.circle_id, units, total: units.reduce((n, u) => n + u.openListings, 0), knownUnits: [...RESOURCE_UNITS] } };
    },
  },
];
