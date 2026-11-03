// Validation of a listing per kind of asset (BE-049, batch 1 of the barter catalogue, #1 to #10). A listing of an on-chain asset that goes to a class A escrow
// must say exactly what will be escrowed, in the keys of the scope of the class A grant on the contract. Three things come from other parts of the repository and are
// kept in step with them by tests: the `asset_type` names are those of the registry D10 (`scripts/lib/asset-catalog.mjs`, UM-075), the shape of the scope follows the
// delivery method of the entry (`escrow_nft`, `escrow_ft`, `escrow_mt`), and `Listing.detail` is the flat JSON that `buildAssetTemplate` of the SDK writes (SD-061):
// the keys of the scope at the top, next to display keys (`decimals`, `symbol`, `display`, `event`, `name`, …) that are not checked. Other asset types are not looked at.
import type { Listing } from "@x207/core";
import { ApiError } from "../api/errors.js";
import { row } from "../api/format.js";
import type { ListingCheck } from "./listings.js";

const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
const U128_MAX = 340282366920938463463374607431768211455n;

export type EscrowMethod = "escrow_nft" | "escrow_ft" | "escrow_mt";
type Shape = "nft" | "ft" | "mt";

/** The asset types of batch 1 with the delivery methods of their entry in D10. A test compares this table with `scripts/lib/asset-catalog.mjs`. */
export const ESCROW_ASSET_TYPES: Readonly<Record<string, { kind: string; delivery: readonly EscrowMethod[] }>> = {
  "nft:nep171": { kind: "nft", delivery: ["escrow_nft"] },
  "ticket:event-nft": { kind: "ticket", delivery: ["escrow_nft"] },
  "game:item-nft": { kind: "game-item", delivery: ["escrow_nft"] },
  "coupon:voucher-nft": { kind: "coupon", delivery: ["escrow_nft"] },
  "license:software-nft": { kind: "license", delivery: ["escrow_nft"] },
  "token:nep141": { kind: "ft", delivery: ["escrow_ft"] },
  "rwa:tokenized": { kind: "rwa", delivery: ["escrow_ft"] },
  "lst:liquid-staking": { kind: "lst", delivery: ["escrow_ft"] },
  "intents:multi-token": { kind: "intents-balance", delivery: ["escrow_mt"] },
  "amm:lp-share": { kind: "pool-share", delivery: ["escrow_ft", "escrow_mt"] },
};

/** The keys of the scope of a class A grant on the contract, per shape. They are the only keys that decide what is escrowed. */
const SCOPE_KEYS: Record<Shape, readonly string[]> = { nft: ["nft_contract", "token_id"], ft: ["ft_contract", "amount"], mt: ["mt_contract", "token_id", "amount"] };
const ALL_SCOPE_KEYS = ["nft_contract", "token_id", "ft_contract", "mt_contract", "amount"];

export interface ScopeOptions {
  /** Token contracts that this circle accepts as real-world-asset tokens (`rwa:tokenized`). Empty: every such listing is refused. */
  rwaWhitelist?: readonly string[];
  /** The Intents contract and the USDT of the circle: `nep141:<usdt>` held at Intents is not an escrow asset (ERR_ESCROW_USDT on the contract). */
  intentsId?: string;
  usdtTokenId?: string;
}

const invalid = (message: string, details: Record<string, unknown> = {}): never => {
  throw new ApiError(400, "scope_invalid", message, details);
};

const isAccount = (v: unknown): v is string => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);
const isAmount = (v: unknown): v is string => typeof v === "string" && /^[1-9]\d*$/.test(v) && BigInt(v) <= U128_MAX;
const isToken = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128;
const isSeconds = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function scopeCheck(options: ScopeOptions = {}): ListingCheck {
  const whitelist = new Set(options.rwaWhitelist ?? []);
  return (listing: Listing, { db, circleId, nowS }) => {
    const offer = (listing as { offer?: { asset_type?: unknown; asset_class?: unknown; quantity?: unknown } }).offer;
    const assetType = offer?.asset_type;
    const entry = typeof assetType === "string" ? ESCROW_ASSET_TYPES[assetType] : undefined;
    if (typeof assetType !== "string" || entry === undefined) return;

    if (offer?.asset_class !== "A") invalid(`offer.asset_class harus A untuk ${assetType}: escrow kontrak hanya untuk kelas A`, { assetType, assetClass: offer?.asset_class ?? null });
    if (offer?.quantity !== 1) invalid(`offer.quantity harus 1 untuk ${assetType}: satu token atau satu lot per listing`, { assetType, quantity: offer?.quantity ?? null });
    const registered = row<{ class: string }>(db, "SELECT class FROM asset_classes WHERE circle_id = ? AND asset_type = ?", circleId, assetType);
    if (!registered) invalid(`asset_type ${assetType} belum terdaftar di registri kelas aset (set_asset_class), escrow-nya tidak akan jalan`, { assetType });
    if (registered && registered.class !== "A") invalid(`asset_type ${assetType} terdaftar dengan kelas ${registered.class}, bukan A`, { assetType, registeredClass: registered.class });

    let detail: unknown;
    try {
      detail = JSON.parse(String((listing as { detail?: unknown }).detail ?? ""));
    } catch {
      return invalid(`detail untuk ${assetType} harus teks JSON datar dengan kunci scope (buildAssetTemplate)`, { assetType });
    }
    if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return invalid(`detail untuk ${assetType} harus objek JSON`, { assetType });
    const d = detail as Record<string, unknown>;

    // the shape comes from the delivery method of the entry; a registry entry with both methods (a pool share) is told apart by the keys of the detail
    let shape: Shape;
    if (entry.delivery.length === 1) shape = entry.delivery[0] === "escrow_nft" ? "nft" : entry.delivery[0] === "escrow_ft" ? "ft" : "mt";
    else if (d.standard === "nep141" || (d.standard === undefined && "ft_contract" in d)) shape = "ft";
    else if (d.standard === "nep245" || (d.standard === undefined && "mt_contract" in d)) shape = "mt";
    else return invalid(`detail untuk ${assetType} harus memakai ft_contract atau mt_contract`, { assetType });
    if (d.kind !== undefined && d.kind !== entry.kind) invalid(`detail.kind ${JSON.stringify(d.kind)} tidak cocok dengan ${assetType} (${entry.kind})`, { assetType });

    const keys = SCOPE_KEYS[shape];
    const missing = keys.filter((k) => !(k in d));
    const foreign = ALL_SCOPE_KEYS.filter((k) => k in d && !keys.includes(k));
    if (missing.length > 0 || foreign.length > 0) invalid(`scope untuk ${assetType} berisi tepat ${keys.join(", ")}`, { assetType, missing, unknown: foreign });
    const contractKey = keys[0] as string;
    if (!isAccount(d[contractKey])) invalid(`${contractKey} bukan account id`, { assetType });
    if (shape !== "ft" && !isToken(d.token_id)) invalid("token_id wajib teks 1 sampai 128 byte", { assetType });
    if (shape !== "nft" && !isAmount(d.amount)) invalid("amount harus string desimal di atas 0 dan tidak melebihi u128 (jumlah persis dalam satuan token)", { assetType });

    const expiresAt = (listing as { expires_at?: number }).expires_at;
    const limit = (what: string, until: unknown): void => {
      if (!isSeconds(until)) invalid(`${what} harus detik unix`, { assetType, value: until ?? null });
      if ((until as number) <= nowS) invalid(`${what} sudah lewat`, { assetType, value: until, now: nowS });
      if (expiresAt !== undefined && expiresAt > (until as number)) invalid(`listing.expires_at tidak boleh melewati ${what}`, { assetType, expiresAt, value: until });
    };
    if (entry.kind === "ticket") {
      const event = d.event;
      const endsAt = event !== null && typeof event === "object" ? (event as Record<string, unknown>).ends_at : undefined;
      if (endsAt === undefined && d.valid_until === undefined) invalid("tiket wajib event.ends_at atau valid_until", { assetType });
      if (endsAt !== undefined) limit("event.ends_at", endsAt);
      if (d.valid_until !== undefined) limit("valid_until", d.valid_until);
    } else if (entry.kind === "coupon") {
      limit("valid_until", d.valid_until);
    } else if (d.valid_until !== undefined) {
      limit("valid_until", d.valid_until);
    }
    if (entry.kind === "license") {
      if (d.terms_hash !== undefined && !(typeof d.terms_hash === "string" && HASH_HEX.test(d.terms_hash))) invalid("terms_hash harus 64 heksadesimal huruf kecil", { assetType });
      if (d.seats !== undefined && !(typeof d.seats === "number" && Number.isSafeInteger(d.seats) && d.seats >= 1)) invalid("seats harus bilangan bulat >= 1", { assetType });
    }

    if (entry.kind === "rwa" && !whitelist.has(d.ft_contract as string)) {
      invalid(`token ${String(d.ft_contract)} tidak ada di whitelist RWA circle ini`, { ftContract: d.ft_contract, whitelisted: [...whitelist] });
    }
    if (shape === "mt" && options.intentsId !== undefined && options.usdtTokenId !== undefined && d.mt_contract === options.intentsId && d.token_id === `nep141:${options.usdtTokenId}`) {
      invalid("USDT lingkaran yang disimpan di Intents bukan aset escrow", { tokenId: d.token_id });
    }
  };
}
