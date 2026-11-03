// Validation of a listing per kind of asset (BE-049, batch 1 of the barter catalogue, #1 to #10). A listing of an on-chain asset that goes to a class A escrow
// (an NFT, a fungible token, a real-world-asset token, a liquid staking token, a multi-token) must say exactly what will be escrowed, in the same form as the scope
// of the class A grant on the contract (`nft_contract`/`token_id`, `ft_contract`/`amount`, `mt_contract`/`token_id`/`amount`). The only free field of a listing is
// `detail`, so for these kinds it is JSON text: `{"scope": {…}, "valid_until": <unix seconds, optional>}`. Other asset types are not looked at.
import type { Listing } from "@x207/core";
import { ApiError } from "../api/errors.js";
import { row } from "../api/format.js";
import type { ListingCheck } from "./listings.js";

const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const U128_MAX = 340282366920938463463374607431768211455n;
/** Asset types that must carry a time of use: the listing may not outlive the ticket or the coupon. */
const EXPIRING = ["nft:ticket", "nft:coupon"];

export interface ScopeOptions {
  /** Token contracts that this circle accepts as real-world-asset tokens (`rwa:*`). Empty: every `rwa:*` listing is refused. */
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

type Shape = "nft" | "ft" | "mt";
const SHAPE_OF: Record<string, Shape> = { nft: "nft", ft: "ft", lst: "ft", rwa: "ft", mt: "mt" };

/** The keys of the scope of a class A grant on the contract, per shape. */
const KEYS: Record<Shape, readonly string[]> = { nft: ["nft_contract", "token_id"], ft: ["ft_contract", "amount"], mt: ["mt_contract", "token_id", "amount"] };

export function scopeCheck(options: ScopeOptions = {}): ListingCheck {
  const whitelist = new Set(options.rwaWhitelist ?? []);
  return (listing: Listing, { db, circleId, nowS }) => {
    const offer = (listing as { offer?: { asset_type?: unknown; asset_class?: unknown; quantity?: unknown } }).offer;
    const assetType = offer?.asset_type;
    if (typeof assetType !== "string" || !assetType.includes(":")) return;
    const prefix = assetType.slice(0, assetType.indexOf(":"));
    const shape = SHAPE_OF[prefix];
    if (shape === undefined) return;

    if (offer?.asset_class !== "A") invalid(`offer.asset_class harus A untuk ${assetType}: escrow kontrak hanya untuk kelas A`, { assetType, assetClass: offer?.asset_class ?? null });
    if (offer?.quantity !== 1) invalid(`offer.quantity harus 1 untuk ${assetType}: satu token atau satu lot per listing`, { assetType, quantity: offer?.quantity ?? null });
    const registered = row<{ class: string }>(db, "SELECT class FROM asset_classes WHERE circle_id = ? AND asset_type = ?", circleId, assetType);
    if (!registered) invalid(`asset_type ${assetType} belum terdaftar di registri kelas aset (set_asset_class), escrow-nya tidak akan jalan`, { assetType });
    if (registered && registered.class !== "A") invalid(`asset_type ${assetType} terdaftar dengan kelas ${registered.class}, bukan A`, { assetType, registeredClass: registered.class });

    let detail: unknown;
    try {
      detail = JSON.parse(String((listing as { detail?: unknown }).detail ?? ""));
    } catch {
      return invalid(`detail untuk ${assetType} harus teks JSON {"scope": {…}}`, { assetType });
    }
    if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return invalid(`detail untuk ${assetType} harus objek JSON {"scope": {…}}`, { assetType });
    const { scope, valid_until: validUntil, ...extra } = detail as Record<string, unknown>;
    if (Object.keys(extra).length > 0) invalid(`detail memuat kunci yang tidak dikenal: ${Object.keys(extra).join(", ")}`, { allowed: ["scope", "valid_until"] });
    if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return invalid("detail.scope harus objek", { assetType });
    const s = scope as Record<string, unknown>;
    const keys = KEYS[shape];
    const wrong = Object.keys(s).filter((k) => !keys.includes(k));
    const missing = keys.filter((k) => !(k in s));
    if (wrong.length > 0 || missing.length > 0) invalid(`scope untuk ${assetType} berisi tepat ${keys.join(", ")}`, { assetType, missing, unknown: wrong });

    const contractKey = keys[0] as string;
    if (!isAccount(s[contractKey])) invalid(`scope.${contractKey} bukan account id`, { assetType });
    if (shape !== "ft" && !isToken(s.token_id)) invalid("scope.token_id wajib teks 1 sampai 128 byte", { assetType });
    if (shape !== "nft" && !isAmount(s.amount)) invalid("scope.amount harus string desimal di atas 0 dan tidak melebihi u128 (jumlah persis dalam satuan token)", { assetType });

    if (EXPIRING.some((t) => assetType === t || assetType.startsWith(`${t}.`) || assetType.startsWith(`${t}-`))) {
      if (typeof validUntil !== "number" || !Number.isSafeInteger(validUntil)) invalid(`${assetType} wajib detail.valid_until (detik unix)`, { assetType });
      if ((validUntil as number) <= nowS) invalid("valid_until sudah lewat", { validUntil, now: nowS });
      if ((listing as { expires_at?: number }).expires_at! > (validUntil as number)) invalid("listing.expires_at tidak boleh melewati valid_until tiket atau kupon", { expiresAt: (listing as { expires_at?: number }).expires_at, validUntil });
    } else if (validUntil !== undefined) {
      if (typeof validUntil !== "number" || !Number.isSafeInteger(validUntil) || validUntil <= nowS) invalid("valid_until harus detik unix di masa depan", { validUntil });
    }

    if (prefix === "rwa" && !whitelist.has(s.ft_contract as string)) {
      invalid(`token ${String(s.ft_contract)} tidak ada di whitelist RWA circle ini`, { ftContract: s.ft_contract, whitelisted: [...whitelist] });
    }
    if (shape === "mt" && options.intentsId !== undefined && options.usdtTokenId !== undefined && s.mt_contract === options.intentsId && s.token_id === `nep141:${options.usdtTokenId}`) {
      invalid("USDT lingkaran yang disimpan di Intents bukan aset escrow", { tokenId: s.token_id });
    }
  };
}
