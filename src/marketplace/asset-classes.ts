// Kelas aset marketplace (BE-042, F8): `asset_type` bebas, `asset_class` harus A/B/C/D, kelas `X` ditolak.
// Daftar lokal ini dipakai sampai registri D10 kontrak (CT-069) ada; setelah itu daftar dibaca dari kontrak.
import { ASSET_CLASSES, type Listing } from "@x207/core";
import { ApiError } from "../api/errors.js";
import type { Route } from "../api/router.js";
import type { ListingCheck } from "./listings.js";

export const ASSET_CLASS_REGISTRY = [
  { class: "A", delivery: "native", description: "Transferred natively through atomic escrow (NFT, NEAR account, on-chain asset)" },
  { class: "B", delivery: "access_key", description: "Rental of NEAR account access through a function-call key" },
  { class: "C", delivery: "tee_broker", description: "TEE broker relays calls through an x402 endpoint" },
  { class: "D", delivery: "x402", description: "Service paid directly with a voucher (flow F2)" },
] as const;

/** Tolak sisi listing yang `asset_class`-nya di luar A/B/C/D (termasuk `X`) dengan 400 `asset_class_rejected`. */
export const assetClassCheck: ListingCheck = (listing: Listing) => {
  for (const side of ["offer", "want"] as const) {
    const assetClass = (listing[side] as { asset_class?: unknown } | undefined)?.asset_class;
    if (assetClass === undefined) continue;
    if (!(ASSET_CLASSES as readonly unknown[]).includes(assetClass)) {
      const hint = assetClass === "X" ? "class X (non-transferable asset) cannot be listed" : "unknown asset class";
      throw new ApiError(400, "asset_class_rejected", `${side}.asset_class ${JSON.stringify(assetClass)} rejected: ${hint}`, {
        side,
        assetClass: assetClass as string,
        allowed: [...ASSET_CLASSES],
      });
    }
  }
};

export const assetClassRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/marketplace/asset-classes",
    circleScoped: true,
    handler: () => ({ status: 200, body: { items: ASSET_CLASS_REGISTRY, source: "local", rejected: ["X"] } }),
  },
];
