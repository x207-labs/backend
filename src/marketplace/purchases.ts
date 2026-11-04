// Handover of a license to content (BE-056, pipeline P7, ADR-46, spec 5g): fair exchange with encryption. The seller posts a ciphertext somewhere and says where (`cipher_posted`), then
// releases the key sealed to the buyer (`key_released`, the signed `LicenseRelease` of the SDK). The VOUCHER OF THE BUYER IS HELD HERE and never given to the seller until the purchase is
// `confirmed` (the buyer confirmed, or the dispute window passed in silence) or `refuted` (the buyer disputed a file that is correct). A file that does not match `content_hash` is
// proven by the proof of cheating of the SDK (`checkCheatProof`), which the backend runs by itself: it downloads the ciphertext from the source the seller named, checks it against
// `cipher_hash`, and checks the proof. A valid proof ends in `disputed` (not paid); a proof for a correct file ends in `refuted` (paid). Every download goes through the SSRF guard.
// Also here: the exclusive license per `content_hash`, the takedown of a listing, the list of `license_id`, and the scan of the preview of a dataset for personal data.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { CODE_DISPUTE_WINDOW_SECONDS, CodeError, ContentHasher, LicenseError, checkCheatProof, checkCodeDocument, codeCommitment, codeDocumentHash, codeResource, httpsRefProblem, licenseResource, parseRawCid, verifyRelease, verifyVoucher, type CheatProof, type CodeDocument, type CodeIssuer, type LicenseRelease, type UnsignedVoucher, type Voucher } from "@x207/core";
import { assertOpenRoom, DEFAULT_OPEN, type OpenLimits } from "../api/abuse.js";
import { ApiError, invalidRequest, type ApiErrorCode } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import type { Route } from "../api/router.js";
import { activeMemberKey } from "./auth.js";
import { nowSeconds } from "./common.js";
import { DEFAULT_DISPUTE_WINDOW_SECONDS } from "./delivery-core.js";
import type { OpenEpochResolver } from "./epoch.js";
import { findListing, type ListingCheck, type ListingRow } from "./listings.js";
import { ACCOUNT, HASH, NOTICE_SKEW_SECONDS, sha256Hex, verifyNoticeJson } from "./notice.js";
import { scanPii } from "./pii.js";
import { guardedGet, type Resolver, type Transport } from "./ssrf.js";

/** The kinds of license that a seller may name, and whether they let the buyer sell the content on (ADR-46 point 6). Standard stock licenses are not on the list. */
export const DEFAULT_LICENSE_IDS: ReadonlyArray<{ id: string; redistribute: boolean; note: string }> = [
  { id: "personal", redistribute: false, note: "use by the buyer alone" },
  { id: "commercial", redistribute: false, note: "use in the business of the buyer" },
  { id: "research", redistribute: false, note: "research and teaching, no commercial use" },
  { id: "own-work", redistribute: false, note: "the seller made it and keeps the rights" },
  { id: "commercial-redistribute", redistribute: true, note: "the buyer may sell the content on" },
  { id: "cc0", redistribute: true, note: "public domain dedication" },
  { id: "cc-by", redistribute: true, note: "attribution" },
  { id: "cc-by-sa", redistribute: true, note: "attribution, share alike" },
];
/** The asset types that sell a license to content (P7); the NFT of a software license (`license:software-nft`, BE-049) is another thing and is not looked at here. */
export const CONTENT_LICENSE_TYPES: ReadonlySet<string> = new Set([
  "data:dataset", "model:weights", "ads:promo-slot", "design:template", "creative:licensed-asset", "plugin:preset", "course:own-class", "content:own-work", "data:own-anonymized",
]);
/** Largest value of a code whose issuer can be asked (ADR-48 point 6): 100 credit. */
export const DEFAULT_VERIFIABLE_CODE_LIMIT = "100000000";
const DISPUTE_REASONS = ["content_mismatch", "contains_pii", "other"] as const;
const BUYER_ACTIONS = ["confirmed", "disputed", "cancelled"] as const;
const ACTIVE = "('paid_held','cipher_posted','key_released','confirmed')";
const MIB = 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = 256 * MIB;
/** Downloads of a ciphertext that run at the same time (memory is bounded by this many files). */
export const MAX_DOWNLOADS = 2;

export class Semaphore {
  #free: number;
  readonly #waiting: Array<() => void> = [];
  constructor(n: number) {
    this.#free = n;
  }
  acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }
  release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free += 1;
  }
}

export interface PurchaseOptions {
  openLimits?: Partial<OpenLimits>;
  disputeWindowSeconds?: number;
  /** Replace the list of `license_id`. */
  licenseIds?: ReadonlyArray<{ id: string; redistribute: boolean; note: string }>;
  ipfsGateways?: readonly string[];
  maxCiphertextBytes?: number;
  /** For the downloads of the sources: replace the DNS resolver and the HTTPS transport (tests). */
  sourceFetch?: { resolver?: Resolver; transport?: Transport };
  /** One-time codes (BE-069, ADR-48): the issuers by name, which the check before the release asks. */
  codeIssuers?: Readonly<Record<string, CodeIssuer>>;
  /** How long a verdict `valid` of the issuer is good for the release of the key, seconds. Default 600. */
  codeCheckTtlSeconds?: number;
  /** Dispute window of a code purchase, seconds. Default 3600 (ADR-48). */
  codeDisputeWindowSeconds?: number;
  /** Value above which a code that cannot be checked needs a bond, smallest unit. Default 20 credit. */
  codeUnverifiableLimit?: string;
  /** Largest value of a code that the issuer can check, smallest unit. Default 100 credit (ADR-48 point 6); above it `code_over_limit_unbonded`. */
  codeVerifiableLimit?: string;
  /** Secret of the operator for `code_seen` (env `X207_CODE_SEEN_KEY`): the backend keeps an HMAC of each code it checked, to refuse the same code in a second live listing. Empty: no detection. */
  codeSeenKey?: string;
}

// ---- the license inside the detail of a listing -----------------------------------------------------------------------------------------------------------------------
interface LicenseDetail {
  license_doc: string;
  content_hash: string;
  license_id: string;
  license_hash: string | null;
  exclusive: boolean;
}

/** The JSON of `Listing.detail` when it describes a license (`kind: "license"`); `null` otherwise. */
function licenseDetail(detail: string): Record<string, unknown> | null {
  try {
    const d: unknown = JSON.parse(detail);
    return d !== null && typeof d === "object" && !Array.isArray(d) && (d as { kind?: unknown }).kind === "license" ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The JSON of `Listing.detail` when it describes a one-time code (`kind: "code"`, BE-069); `null` otherwise. */
function codeDetail(detail: string): Record<string, unknown> | null {
  try {
    const d: unknown = JSON.parse(detail);
    return d !== null && typeof d === "object" && !Array.isArray(d) && (d as { kind?: unknown }).kind === "code" ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const bad = (message: string, details: Record<string, unknown> = {}): never => {
  throw new ApiError(400, "scope_invalid", message, details);
};

/** Check of a listing that sells a license: the fields, the `license_id`, and the preview (hash and personal data). */
export const licenseCheck = (options: PurchaseOptions = {}): ListingCheck => (listing) => {
  const assetType = (listing as { offer?: { asset_type?: unknown } }).offer?.asset_type;
  if (typeof assetType !== "string" || !CONTENT_LICENSE_TYPES.has(assetType)) return;
  const d = licenseDetail(String((listing as { detail?: unknown }).detail ?? ""));
  if (d === null) return;
  const ids = options.licenseIds ?? DEFAULT_LICENSE_IDS;
  for (const key of ["license_doc", "content_hash"] as const) if (typeof d[key] !== "string" || !HASH.test(d[key] as string)) bad(`${key} must be 64 lowercase hex characters in the license listing detail`);
  if (typeof d.exclusive !== "boolean") bad("exclusive must be a boolean in the license listing detail");
  if (typeof d.license_id !== "string" || !ids.some((i) => i.id === d.license_id)) {
    throw new ApiError(400, "license_id_rejected", "license_id is not in the accepted list", { licenseId: d.license_id ?? null, allowed: ids.map((i) => i.id) });
  }
  if (d.preview !== undefined) {
    if (typeof d.preview !== "string" || d.preview.length > 16_384) bad("preview must be text of at most 16384 characters");
    const preview = d.preview as string;
    if (typeof d.preview_hash === "string" && d.preview_hash !== sha256Hex(preview.trim())) bad("preview_hash must be the sha256 of preview");
    const found = scanPii(preview);
    if (found.length > 0) throw new ApiError(400, "preview_contains_pii", "Preview contains personal data; post a preview without personal data", { kinds: found });
  }
};

/**
 * Check of a listing that sells a one-time code (BE-069). The detail holds the fields of the code document of the SDK (SD-076) and the hash of that document; the document is built again from the
 * listing (circle, seller, value) and must hash to `code_doc`, so nothing of it can change after the signature. The value cap of a code that cannot be checked, the arbiter, and the issuer are checked here.
 */
export const codeCheck = (options: PurchaseOptions = {}): ListingCheck => (listing) => {
  const l = listing as { detail?: unknown; account?: string; circle?: string; offer?: { value?: string } };
  const d = codeDetail(String(l.detail ?? ""));
  if (d === null) return;
  if (typeof d.code_doc !== "string" || !HASH.test(d.code_doc)) bad("code_doc must be 64 lowercase hex characters in the code listing detail");
  if (d.identity_bound === true) throw new ApiError(400, "code_bound_to_identity", "Code bound to its owner's identity cannot be sold", {});
  const doc: CodeDocument = { circle: l.circle as string, seller: l.account as string, code_commitment: d.code_commitment as string, issuer: d.issuer as string, value: l.offer?.value as string, verifiable: d.verifiable as boolean, arbiter: (d.arbiter as string | null | undefined) ?? null, nonce: d.nonce as string };
  // ADR-48 points 6 and 7: the arbiter of the document is only a name (no bond exists for a sale paid by one voucher), so it neither lifts a cap nor is accepted; the caps hold whatever it says
  if (doc.arbiter !== null) throw new ApiError(400, "arbiter_not_supported", "arbiter is not supported for code sales: no bond is locked, so the value limit applies without exception", { arbiter: doc.arbiter });
  try {
    const normal = checkCodeDocument(doc, options.codeUnverifiableLimit);
    if (codeDocumentHash(normal) !== d.code_doc) bad("code_doc is not the hash of the code document built from this listing (circle, seller, value, and detail fields)");
    // a code that the issuer can check is capped too, at a higher value (100 credit by default)
    if (normal.verifiable && BigInt(normal.value) > BigInt(options.codeVerifiableLimit ?? DEFAULT_VERIFIABLE_CODE_LIMIT)) {
      throw new ApiError(400, "code_over_limit_unbonded", `verifiable code is limited to ${options.codeVerifiableLimit ?? DEFAULT_VERIFIABLE_CODE_LIMIT} units; no bond can raise it`, { limit: options.codeVerifiableLimit ?? DEFAULT_VERIFIABLE_CODE_LIMIT });
    }
  } catch (error) {
    if (error instanceof CodeError) throw new ApiError(400, error.code as ApiErrorCode, error.message, {});
    throw error;
  }
  if (doc.verifiable && options.codeIssuers?.[doc.issuer] === undefined) throw new ApiError(400, "code_issuer_unknown", `issuer ${doc.issuer} is not registered on this backend`, { issuer: doc.issuer });
};

function detailOf(listing: ListingRow): LicenseDetail & { kind: "license" | "code" } {
  const code = codeDetail(listing.detail);
  if (code !== null && typeof code.code_doc === "string" && typeof code.code_commitment === "string") {
    return { kind: "code", license_doc: code.code_doc, content_hash: code.code_commitment, license_id: "one-time-code", license_hash: null, exclusive: true };
  }
  const d = licenseDetail(listing.detail);
  if (d === null || typeof d.license_doc !== "string" || typeof d.content_hash !== "string" || typeof d.license_id !== "string" || typeof d.exclusive !== "boolean") {
    throw new ApiError(409, "listing_not_open", "This listing is not a license listing", { listingHash: listing.listing_hash });
  }
  return { kind: "license", license_doc: d.license_doc, content_hash: d.content_hash, license_id: d.license_id, license_hash: typeof d.license_hash === "string" ? d.license_hash : null, exclusive: d.exclusive };
}

// ---- rows and views ---------------------------------------------------------------------------------------------------------------------------------------------------
interface PurchaseRow {
  id: bigint;
  kind: string;
  listing_hash: string;
  buyer: string;
  seller: string;
  content_hash: string;
  license_doc: string;
  license_id: string;
  exclusive: bigint;
  voucher_json: string;
  voucher_signature: string;
  status: string;
  source_kind: string | null;
  source_ref: string | null;
  cipher_hash: string | null;
  release_json: string | null;
  release_signature: string | null;
  released_at: bigint | null;
  dispute_until: bigint | null;
  auto_confirmed: bigint;
  dispute_reason: string | null;
  created_at_ms: bigint;
}

function findPurchase(db: Database.Database, circleId: string, id: string): PurchaseRow {
  const found = /^[1-9]\d*$/.test(id) ? row<PurchaseRow>(db, "SELECT * FROM purchases WHERE circle_id = ? AND id = ?", circleId, BigInt(id)) : undefined;
  if (!found) throw new ApiError(404, "purchase_not_found", `Purchase ${id} not found`, { purchaseId: id });
  return found;
}

/** The voucher is shown only when the money may move: confirmed (by the buyer or by silence) or refuted (a false dispute). Before that it stays here. */
const releasable = (p: PurchaseRow): boolean => p.status === "confirmed" || p.status === "refuted";

export function purchaseView(p: PurchaseRow) {
  return {
    purchaseId: p.id.toString(),
    kind: p.kind,
    listingHash: p.listing_hash,
    buyer: p.buyer,
    seller: p.seller,
    status: p.status,
    contentHash: p.content_hash,
    licenseId: p.license_id,
    exclusive: p.exclusive === 1n,
    needsBond: p.exclusive === 1n && p.kind === "license",
    source: p.source_kind === null ? null : { kind: p.source_kind, ref: p.source_ref },
    cipherHash: p.cipher_hash,
    release: p.release_json === null ? null : (JSON.parse(p.release_json) as LicenseRelease),
    releaseSignature: p.release_signature,
    disputeUntil: p.dispute_until === null ? null : Number(p.dispute_until),
    autoConfirmed: p.auto_confirmed === 1n,
    disputeReason: p.dispute_reason,
    ...(releasable(p) ? { voucher: JSON.parse(p.voucher_json) as UnsignedVoucher, voucherSignature: p.voucher_signature } : {}),
  };
}

/** A key released and left alone for the whole window is confirmed (ADR-42): the buyer could dispute until `dispute_until`. */
export function settlePurchases(db: Database.Database, circleId: string, nowS: number, nowMs: number): void {
  db.prepare("UPDATE purchases SET status = 'confirmed', auto_confirmed = 1, closed_at_ms = ? WHERE circle_id = ? AND status = 'key_released' AND dispute_until < ?").run(nowMs, circleId, nowS);
}

// ---- the sources --------------------------------------------------------------------------------------------------------------------------------------------------------
type Source = { kind: "https" | "ipfs"; ref: string };

function sourceUrl(source: Source, gateways: readonly string[]): string {
  if (source.kind === "https") return source.ref;
  return `${(gateways[0] as string).replace(/\/+$/, "")}/ipfs/${source.ref}`;
}

function parseSource(raw: unknown): Source {
  const s = raw as { kind?: unknown; ref?: unknown } | null;
  if (s === null || typeof s !== "object" || (s.kind !== "https" && s.kind !== "ipfs") || typeof s.ref !== "string") throw invalidRequest("source must be {kind: https or ipfs, ref}");
  if (s.kind === "https") {
    const problem = httpsRefProblem(s.ref);
    if (problem !== null) throw new ApiError(403, "source_forbidden", problem, { kind: "https" });
  } else {
    try {
      parseRawCid(s.ref);
    } catch (error) {
      if (error instanceof LicenseError) throw new ApiError(403, "source_forbidden", error.message, { kind: "ipfs" });
      throw error;
    }
  }
  return { kind: s.kind, ref: s.ref };
}

export function purchaseRoutes(resolveOpenEpoch: OpenEpochResolver, options: PurchaseOptions = {}): Route[] {
  const window = options.disputeWindowSeconds ?? DEFAULT_DISPUTE_WINDOW_SECONDS;
  const gateways = options.ipfsGateways ?? ["https://ipfs.io"];
  const maxBytes = options.maxCiphertextBytes ?? MAX_CIPHERTEXT_BYTES;
  const guard = { ...(options.sourceFetch?.resolver ? { resolver: options.sourceFetch.resolver } : {}), ...(options.sourceFetch?.transport ? { transport: options.sourceFetch.transport } : {}), code: "source_forbidden" as const };
  const ids = options.licenseIds ?? DEFAULT_LICENSE_IDS;
  const downloads = new Semaphore(MAX_DOWNLOADS);
  const codeWindow = options.codeDisputeWindowSeconds ?? CODE_DISPUTE_WINDOW_SECONDS;
  const checkTtlMs = (options.codeCheckTtlSeconds ?? 600) * 1000;

  const refuse = (message: string, details: Record<string, unknown> = {}): never => {
    throw new ApiError(409, "purchase_bad_state", message, details);
  };

  /** The key of a code may be released only after a fresh verdict `valid`, when its issuer can be asked. A `used` code ends the sale: the purchase and the listing are cancelled, nothing moves. */
  function assertCodeGood(db: Database.Database, circleId: string, p: PurchaseRow, listingDetail: string, nowMs: number): void {
    const cd = codeDetail(listingDetail);
    if (cd === null || cd.verifiable !== true) return;
    const c = row<{ verdict: string; checked_at_ms: bigint }>(db, "SELECT verdict, checked_at_ms FROM code_checks WHERE circle_id = ? AND listing_hash = ?", circleId, p.listing_hash);
    if (c === undefined || nowMs - Number(c.checked_at_ms) > checkTtlMs) throw new ApiError(409, "code_not_checked", "This code must be checked with the issuer first (POST …/code-check) before the key is released; the check result is valid only briefly", { ttlSeconds: checkTtlMs / 1000 });
    if (c.verdict === "used") {
      cancelCodeSale(db, circleId, p.listing_hash, nowMs);
      throw new ApiError(409, "code_used", "The issuer states this code is already used; the purchase is cancelled and the voucher is not transferred", {});
    }
    if (c.verdict !== "valid") throw new ApiError(409, "code_unknown", "The issuer does not recognize this code; the key is not released", {});
  }
  function cancelCodeSale(db: Database.Database, circleId: string, listingHash: string, nowMs: number): void {
    db.transaction(() => {
      db.prepare("UPDATE purchases SET status = 'cancelled', dispute_reason = 'code_used', closed_at_ms = ? WHERE circle_id = ? AND listing_hash = ? AND status IN ('paid_held','cipher_posted')").run(nowMs, circleId, listingHash);
      db.prepare("UPDATE listings SET status = 'cancelled', closed_at_ms = ? WHERE circle_id = ? AND listing_hash = ? AND status = 'open'").run(nowMs, circleId, listingHash);
    })();
  }
  const notParty = (actor: string, message: string): never => {
    throw new ApiError(403, "purchase_not_party", message, { actor });
  };

  /** Is the address up? HEAD through the guard. */
  async function checkAvailable(source: Source): Promise<void> {
    const res = await guardedGet(sourceUrl(source, gateways), { ...guard, method: "HEAD" });
    if (!res.reachable || res.status < 200 || res.status >= 300) refuse("The source did not respond successfully (HEAD)", { kind: source.kind, status: res.reachable ? res.status : null });
  }

  /**
   * The ciphertext as the source serves it now, CHECKED while it arrives: its hash (`cipher_hash`, the Merkle root of the SDK) is computed piece by piece and the pieces go to a temporary
   * file, so a file that does not match is refused without ever being loaded. Only a file that matches is read back for the proof, and `fn` gets it. At most `MAX_DOWNLOADS` run at once,
   * so the memory in use is bounded by that many files; the temporary file is always deleted. The deadline grows with the size allowed: 60 s plus one second per MiB, at most ten minutes.
   */
  async function withCiphertext<T>(source: Source, cipherHash: string, cipherSize: number, fn: (ciphertext: Buffer) => T | Promise<T>): Promise<T> {
    await downloads.acquire();
    const path = join(tmpdir(), `x207-cipher-${randomBytes(8).toString("hex")}.tmp`);
    const fd = openSync(path, "w", 0o600);
    const hasher = new ContentHasher();
    const plain = createHash("sha256");
    let received = 0;
    try {
      const res = await guardedGet(sourceUrl(source, gateways), {
        ...guard, maxBytes, timeoutMs: Math.min(60_000 + Math.ceil(maxBytes / MIB) * 1000, 600_000),
        onChunk: (c) => {
          received += c.length;
          hasher.update(c);
          plain.update(c);
          writeSync(fd, c);
        },
      });
      if (!res.reachable || res.status !== 200) refuse("The ciphertext cannot be downloaded from the source", { kind: source.kind, status: res.reachable ? res.status : null });
      if (source.kind === "ipfs" && !Buffer.from(parseRawCid(source.ref).digest).equals(plain.digest())) throw new ApiError(400, "proof_invalid", "Bytes from the gateway do not match the CID", {});
      // the size is signed in the release (review BE-062 F1): a body of another size is refused before the hash is even compared, so the 65-byte body of a Merkle node never counts
      if (received !== cipherSize) throw new ApiError(400, "proof_invalid", `The source served ${received} bytes, the release signed ${cipherSize}`, {});
      if (hasher.digest() !== cipherHash) throw new ApiError(400, "proof_invalid", "The source no longer serves the ciphertext with the posted cipher_hash", {});
      closeSync(fd);
      return await fn(readFileSync(path));
    } finally {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
      downloads.release();
    }
  }

  function record(db: Database.Database, circleId: string, p: PurchaseRow, actor: string, action: string, at: number, signature: string, nowMs: number, noticeText: string): void {
    const inserted = db
      .prepare("INSERT OR IGNORE INTO purchase_notices (circle_id, purchase_id, notice_hash, actor, action, at_s, signature, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(circleId, p.id, sha256Hex(noticeText), actor, action, at, signature, nowMs);
    if (inserted.changes === 0) throw new ApiError(409, "already_exists", "This notice is already recorded", {});
  }

  return [
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/listings/{hash}/code-check",
      circleScoped: true,
      handler: async ({ db, circle, params, body, now }) => {
        const nowS = nowSeconds(now());
        const listing = findListing(db, circle.circle_id, params.hash as string);
        const cd = codeDetail(listing.detail);
        if (cd === null || typeof cd.code_commitment !== "string") throw new ApiError(409, "listing_not_open", "This listing is not a code listing", { listingHash: listing.listing_hash });
        if (listing.status !== "open" || Number(listing.expires_at) <= nowS) throw new ApiError(409, "listing_not_open", "Listing is not open", { listingHash: listing.listing_hash, status: listing.status });
        if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
        const { notice, signature, code, salt } = body as { notice?: Record<string, unknown>; signature?: unknown; code?: unknown; salt?: unknown };
        if (typeof signature !== "string") throw invalidRequest("signature must be a string");
        if (notice === null || typeof notice !== "object") throw invalidRequest("notice must be an object");
        // keys: circle, listing_hash, actor, action, at; action is "check". The signature covers the listing, so a check of one listing cannot be shown for another.
        if (Object.keys(notice).join(",") !== "circle,listing_hash,actor,action,at") throw invalidRequest("notice keys must be circle, listing_hash, actor, action, at (fixed order)");
        if (notice.circle !== circle.contract_id) throw invalidRequest("notice.circle must be the circle contract account", { expected: circle.contract_id, got: notice.circle });
        if (notice.listing_hash !== listing.listing_hash || notice.action !== "check") throw invalidRequest("notice.listing_hash must be this listing and action must be check");
        if (!Number.isSafeInteger(notice.at) || Math.abs((notice.at as number) - nowS) > NOTICE_SKEW_SECONDS) throw invalidRequest(`notice.at must be unix seconds within ${NOTICE_SKEW_SECONDS} seconds of the server clock`);
        if (notice.actor !== listing.account_id) throw new ApiError(403, "purchase_not_party", "Only the seller may present their code for checking", { actor: notice.actor });
        if (!verifyNoticeJson(JSON.stringify(notice), circle.contract_id, signature, activeMemberKey(db, circle.circle_id, listing.account_id))) {
          throw new ApiError(401, "invalid_signature", "Notice signature does not match the seller's key", { account: listing.account_id });
        }
        // from here on nothing that holds the code or the salt may reach a message, a detail, a log or a table
        if (typeof code !== "string" || typeof salt !== "string" || !HASH.test(salt)) throw invalidRequest("code (text) and salt (64 lowercase hex characters) are required");
        let commitment: string;
        try {
          commitment = codeCommitment(code, Uint8Array.from(Buffer.from(salt, "hex")));
        } catch (error) {
          if (error instanceof CodeError) throw new ApiError(400, error.code as ApiErrorCode, "code is not valid (length or characters)", {});
          throw error;
        }
        if (commitment !== cd.code_commitment) throw new ApiError(400, "code_bad_commitment", "salt and code do not match the listing code_commitment", {});
        if (cd.verifiable !== true) throw new ApiError(400, "code_not_verifiable", "This code's issuer has no check; nothing was checked", { issuer: cd.issuer });
        const issuer = options.codeIssuers?.[String(cd.issuer)];
        if (issuer === undefined) throw new ApiError(400, "code_issuer_unknown", `issuer ${String(cd.issuer)} is not registered on this backend`, { issuer: cd.issuer });
        // the same code in another listing that is open or sold: refused (only codes the issuer can check; the key of the operator makes the HMAC useless to somebody who steals the table)
        const mac = options.codeSeenKey ? createHmac("sha256", options.codeSeenKey).update(`${String(cd.issuer)}\u0000${code}`).digest("hex") : null;
        if (mac !== null) {
          const other = row<{ listing_hash: string }>(
            db,
            `SELECT s.listing_hash FROM code_seen s JOIN listings l ON l.circle_id = s.circle_id AND l.listing_hash = s.listing_hash
              WHERE s.circle_id = ? AND s.mac = ? AND s.listing_hash <> ?
                AND ((l.status = 'open' AND l.expires_at > ?) OR EXISTS (SELECT 1 FROM purchases p WHERE p.circle_id = s.circle_id AND p.listing_hash = s.listing_hash AND p.status IN ${ACTIVE}))
              LIMIT 1`,
            circle.circle_id, mac, listing.listing_hash, nowS,
          );
          if (other !== undefined) throw new ApiError(409, "code_duplicate", "The same code is already in another open or sold listing", { otherListing: other.listing_hash });
        }
        let verdict: "valid" | "used" | "unknown";
        try {
          verdict = await issuer.checkCode(code);
        } catch {
          throw new ApiError(503, "code_issuer_unavailable", "The issuer did not respond; no decision yet, try again", { issuer: cd.issuer });
        }
        if (mac !== null) db.prepare("INSERT OR IGNORE INTO code_seen (circle_id, mac, listing_hash, seen_at_ms) VALUES (?, ?, ?, ?)").run(circle.circle_id, mac, listing.listing_hash, now());
        db.prepare("INSERT INTO code_checks (circle_id, listing_hash, verdict, checked_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT (circle_id, listing_hash) DO UPDATE SET verdict = excluded.verdict, checked_at_ms = excluded.checked_at_ms").run(circle.circle_id, listing.listing_hash, verdict, now());
        if (verdict === "used") cancelCodeSale(db, circle.circle_id, listing.listing_hash, now());
        return { status: 200, body: { listingHash: listing.listing_hash, verdict, checkedAt: now(), validUntilMs: verdict === "valid" ? now() + checkTtlMs : null } };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/listings/{hash}/code-check",
      circleScoped: true,
      handler: ({ db, circle, params, now }) => {
        const listing = findListing(db, circle.circle_id, params.hash as string);
        const cd = codeDetail(listing.detail);
        if (cd === null) throw new ApiError(409, "listing_not_open", "This listing is not a code listing", { listingHash: listing.listing_hash });
        const c = row<{ verdict: string; checked_at_ms: bigint }>(db, "SELECT verdict, checked_at_ms FROM code_checks WHERE circle_id = ? AND listing_hash = ?", circle.circle_id, listing.listing_hash);
        const checkedAt = c === undefined ? null : Number(c.checked_at_ms);
        return {
          status: 200,
          body: { listingHash: listing.listing_hash, issuer: cd.issuer, verifiable: cd.verifiable === true, verdict: c?.verdict ?? null, checkedAt, fresh: checkedAt !== null && now() - checkedAt <= checkTtlMs, listingStatus: listing.status },
        };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/marketplace/license-ids",
      circleScoped: true,
      handler: () => ({ status: 200, body: { items: ids.map((i) => ({ licenseId: i.id, redistribute: i.redistribute, note: i.note })) } }),
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/marketplace/exclusive-licenses",
      circleScoped: true,
      handler: ({ db, circle, query, now }) => {
        settlePurchases(db, circle.circle_id, nowSeconds(now()), now());
        const contentFilter = query.get("content_hash");
        if (contentFilter !== null && !HASH.test(contentFilter)) throw invalidRequest("content_hash must be 64 lowercase hex characters");
        const found = rows<PurchaseRow>(db, `SELECT * FROM purchases WHERE circle_id = ? AND exclusive = 1 AND status IN ${ACTIVE} AND (? IS NULL OR content_hash = ?) ORDER BY id`, circle.circle_id, contentFilter, contentFilter);
        return { status: 200, body: { items: found.map((p) => ({ contentHash: p.content_hash, purchaseId: p.id.toString(), listingHash: p.listing_hash, seller: p.seller, buyer: p.buyer, status: p.status })) } };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/listings/{hash}/purchases",
      circleScoped: true,
      handler: async ({ db, circle, params, body, now }) => {
        settlePurchases(db, circle.circle_id, nowSeconds(now()), now());
        const listing = findListing(db, circle.circle_id, params.hash as string);
        if (listing.status !== "open" || Number(listing.expires_at) <= nowSeconds(now())) throw new ApiError(409, "listing_not_open", "Listing is not open", { listingHash: listing.listing_hash, status: listing.status });
        const d = detailOf(listing);
        const { voucher, signature } = (body ?? {}) as { voucher?: Record<string, unknown>; signature?: unknown };
        if (voucher === null || typeof voucher !== "object" || typeof signature !== "string") throw invalidRequest("voucher and signature are required");
        const v = voucher as unknown as UnsignedVoucher;
        if (v.circle !== circle.contract_id) throw invalidRequest("voucher.circle must be the circle contract account", { expected: circle.contract_id, got: v.circle });
        if (v.payee !== listing.account_id) throw invalidRequest("voucher.payee must be the listing seller", { expected: listing.account_id });
        if (v.payer === v.payee) throw invalidRequest("buyer must not be the seller");
        const expectedResource = d.kind === "code" ? codeResource(d.license_doc) : licenseResource(d.license_doc);
        if (v.resource !== expectedResource) throw invalidRequest(d.kind === "code" ? "voucher.resource must be x207:code:<code_doc>" : "voucher.resource must be x207:license:<license_doc>", { expected: expectedResource });
        const key = activeMemberKey(db, circle.circle_id, v.payer);
        if (!verifyVoucher({ ...v, signature } as Voucher, key)) throw new ApiError(401, "invalid_signature", "Voucher signature does not match the buyer's voucher key", { account: v.payer });
        const open = await resolveOpenEpoch(db, circle);
        if (open === null || v.epoch !== open) throw new ApiError(409, "epoch_not_open", "Voucher must be for the current open epoch", { expected: open, got: v.epoch });
        const state = row<{ seq: bigint; cumulative_amount: bigint }>(db, "SELECT seq, cumulative_amount FROM obligations WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?", circle.circle_id, v.epoch, v.payer, v.payee);
        const price = BigInt(listing.offer_value);
        // B7-C3: the vouchers of this pair that other purchases hold and the seller has not registered yet are part of the state: the contract takes only the delta over the highest
        // cumulative, so a second voucher with the same cumulative would pay nothing
        let baseSeq = state?.seq ?? 0n;
        let baseCumulative = state?.cumulative_amount ?? 0n;
        for (const held of rows<{ voucher_json: string }>(db, "SELECT voucher_json FROM purchases WHERE circle_id = ? AND buyer = ? AND seller = ? AND status <> 'cancelled'", circle.circle_id, v.payer, v.payee)) {
          const h = JSON.parse(held.voucher_json) as UnsignedVoucher;
          if (h.epoch !== v.epoch) continue;
          if (BigInt(h.seq) > baseSeq) baseSeq = BigInt(h.seq);
          if (BigInt(h.cumulativeAmount) > baseCumulative) baseCumulative = BigInt(h.cumulativeAmount);
        }
        if (BigInt(v.seq) <= baseSeq || BigInt(v.cumulativeAmount) - baseCumulative < price) {
          throw invalidRequest("voucher must continue the pair state (seq increases, counting the vouchers that purchases still hold) and add at least the listing price", { price: price.toString() });
        }
        // exclusivity per content hash: an exclusive license excludes every other, and nothing is sold exclusively while another license of that content is alive
        const clash = row<{ n: bigint }>(
          db,
          `SELECT COUNT(*) AS n FROM purchases WHERE circle_id = ? AND content_hash = ? AND status IN ${ACTIVE} AND (? = 1 OR exclusive = 1)`,
          circle.circle_id, d.content_hash, d.exclusive ? 1 : 0,
        );
        if ((clash?.n ?? 0n) > 0n) throw new ApiError(409, "exclusive_taken", "This content already has an exclusive license, or another license that blocks an exclusive license", { contentHash: d.content_hash });
        assertOpenRoom(db, "SELECT COUNT(*) AS n FROM purchases WHERE circle_id = ? AND buyer = ? AND status IN ('paid_held','cipher_posted','key_released','disputed')", [circle.circle_id, v.payer], options.openLimits?.purchases ?? DEFAULT_OPEN.purchases, "purchase", v.payer);
        const id = db
          .prepare(
            `INSERT INTO purchases (circle_id, listing_hash, buyer, seller, content_hash, license_doc, license_id, exclusive, voucher_json, voucher_signature, created_at_ms, kind)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(circle.circle_id, listing.listing_hash, v.payer, v.payee, d.content_hash, d.license_doc, d.license_id, d.exclusive ? 1 : 0, JSON.stringify(v), signature, now(), d.kind).lastInsertRowid;
        const p = findPurchase(db, circle.circle_id, String(id));
        return { status: 201, body: { purchase_id: p.id.toString(), ...purchaseView(p) } };
      },
    },
    {
      method: "GET",
      pattern: "/x207/circles/{circle}/purchases/{id}",
      circleScoped: true,
      handler: ({ db, circle, params, now }) => {
        settlePurchases(db, circle.circle_id, nowSeconds(now()), now());
        return { status: 200, body: purchaseView(findPurchase(db, circle.circle_id, params.id as string)) };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/purchases/{id}",
      circleScoped: true,
      handler: async ({ db, circle, params, body, now }) => {
        const nowS = nowSeconds(now());
        settlePurchases(db, circle.circle_id, nowS, now());
        const p = findPurchase(db, circle.circle_id, params.id as string);
        if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
        const { notice, signature } = body as { notice?: Record<string, unknown>; signature?: unknown };
        if (typeof signature !== "string") throw invalidRequest("signature must be a string");
        if (notice === null || typeof notice !== "object") throw invalidRequest("notice must be an object");
        const skew = (at: unknown): number => {
          if (!Number.isSafeInteger(at) || (at as number) < 1) throw invalidRequest("at must be integer unix seconds");
          if (Math.abs((at as number) - nowS) > NOTICE_SKEW_SECONDS) throw invalidRequest(`notice.at deviates more than ${NOTICE_SKEW_SECONDS} seconds from the server clock`, { at, now: nowS });
          return at as number;
        };

        // ---- key_released: the notice is the release of the SDK, signed with the signing of the SDK
        if (typeof notice.sealed_key === "string") {
          const r = notice as unknown as LicenseRelease;
          if (p.status !== "cipher_posted") refuse(`key_released only from cipher_posted, current state is ${p.status}`, { status: p.status });
          const at = skew(r.at);
          const d = (row<{ detail: string }>(db, "SELECT detail FROM listings WHERE circle_id = ? AND listing_hash = ?", circle.circle_id, p.listing_hash)?.detail ?? "");
          const detail = licenseDetail(d);
          if (r.circle !== circle.contract_id || r.buyer !== p.buyer || r.cipher_hash !== p.cipher_hash || r.content_hash !== p.content_hash) {
            throw invalidRequest("release must be for this circle, buyer, cipher_hash, and content_hash of this purchase");
          }
          // the release names the purchase it serves (review BE-062 F12), its sizes (F1) and the commitment to the key (F11)
          if (r.purchase_id !== p.id.toString()) throw invalidRequest("release.purchase_id must be the id of this purchase", { expected: p.id.toString(), got: r.purchase_id ?? null });
          if (!Number.isSafeInteger(r.content_size) || !Number.isSafeInteger(r.cipher_size) || r.content_size < 0 || r.cipher_size < 1) throw invalidRequest("release.content_size and release.cipher_size must be integers (cipher_size > 0)");
          if (typeof r.key_commitment !== "string" || !HASH.test(r.key_commitment)) throw invalidRequest("release.key_commitment must be 64 lowercase hex characters");
          if (r.license_hash !== p.license_doc && r.license_hash !== detail?.license_hash) throw invalidRequest("release.license_hash must be license_doc or license_hash from the listing");
          if (!verifyRelease(r, signature, activeMemberKey(db, circle.circle_id, p.seller))) throw new ApiError(401, "invalid_signature", "Release signature does not match the seller's key", { account: p.seller });
          // a code is short: the payload is a salt of 32 bytes and at most 1024 bytes of code, so a seller cannot ship the buyer a "code" of a gigabyte or a wall of control characters (B6-F5)
          if (p.kind === "code" && (r.content_size < 32 + 8 || r.content_size > 32 + 1024 || r.cipher_size > r.content_size + 64)) {
            throw invalidRequest("code: content_size must be 40 to 1056 bytes (salt 32 + code 8 to 1024) and cipher_size at most content_size + 64", { contentSize: r.content_size, cipherSize: r.cipher_size });
          }
          // a code that the issuer can check is checked before the key goes to the buyer (ADR-48)
          if (p.kind === "code") assertCodeGood(db, circle.circle_id, p, d, now());
          db.transaction(() => {
            record(db, circle.circle_id, p, p.seller, "key_released", at, signature, now(), JSON.stringify(r));
            db.prepare("UPDATE purchases SET status = 'key_released', release_json = ?, release_signature = ?, released_at = ?, dispute_until = ? WHERE id = ?").run(JSON.stringify(r), signature, at, at + (p.kind === "code" ? codeWindow : window), p.id);
          })();
          return { status: 201, body: purchaseView(findPurchase(db, circle.circle_id, params.id as string)) };
        }

        const actor = notice.actor;
        if (typeof actor !== "string" || !ACCOUNT.test(actor)) throw invalidRequest("notice.actor must be an account id");
        if (notice.circle !== circle.contract_id) throw invalidRequest("notice.circle must be the circle contract account", { expected: circle.contract_id, got: notice.circle });
        if (notice.purchase_id !== p.id.toString()) throw invalidRequest("notice.purchase_id must be the id of this purchase", { expected: p.id.toString() });
        if (actor !== p.buyer && actor !== p.seller) notParty(actor, "Only the buyer or seller may send a notice");
        const at = skew(notice.at);
        const action = notice.action;

        if (action === "cipher_posted") {
          // keys: circle, purchase_id, actor, action, at, source, cipher_hash
          if (actor !== p.seller) notParty(actor, "Only the seller may post the ciphertext");
          if (p.status !== "paid_held" && p.status !== "cipher_posted") refuse(`cipher_posted only from paid_held, current state is ${p.status}`, { status: p.status });
          if (typeof notice.cipher_hash !== "string" || !HASH.test(notice.cipher_hash)) throw invalidRequest("cipher_hash must be 64 lowercase hex characters");
          const source = parseSource(notice.source);
          const text = JSON.stringify({ circle: notice.circle, purchase_id: notice.purchase_id, actor, action, at, source: { kind: source.kind, ref: source.ref }, cipher_hash: notice.cipher_hash });
          if (!verifyNoticeJson(text, circle.contract_id, signature, activeMemberKey(db, circle.circle_id, actor))) throw new ApiError(401, "invalid_signature", "Notice signature does not match the seller's key", { account: actor });
          await checkAvailable(source);
          db.transaction(() => {
            record(db, circle.circle_id, p, actor, String(action), at, signature, now(), text);
            db.prepare("UPDATE purchases SET status = 'cipher_posted', source_kind = ?, source_ref = ?, cipher_hash = ? WHERE id = ?").run(source.kind, source.ref, notice.cipher_hash, p.id);
          })();
          return { status: 201, body: purchaseView(findPurchase(db, circle.circle_id, params.id as string)) };
        }

        // ---- confirmed, disputed, cancelled: keys circle, purchase_id, actor, action, at, reason, proof (the format of FE-028)
        if (!(BUYER_ACTIONS as readonly unknown[]).includes(action)) throw invalidRequest("action is not recognized", { allowed: ["cipher_posted", "key_released", ...BUYER_ACTIONS] });
        const reason = notice.reason ?? null;
        const proof = notice.proof ?? null;
        const keys = Object.keys(notice).join(",");
        if (keys !== "circle,purchase_id,actor,action,at,reason,proof") throw invalidRequest("notice keys must be circle, purchase_id, actor, action, at, reason, proof (fixed order)");
        const text = JSON.stringify(notice);
        if (!verifyNoticeJson(text, circle.contract_id, signature, activeMemberKey(db, circle.circle_id, actor))) throw new ApiError(401, "invalid_signature", "Notice signature does not match the member's voucher key", { account: actor });
        const isBuyer = actor === p.buyer;

        if (action === "confirmed") {
          if (!isBuyer) notParty(actor, "Only the buyer may confirm");
          if (p.status !== "key_released") refuse(`confirmed only from key_released, current state is ${p.status}`, { status: p.status });
          db.transaction(() => {
            record(db, circle.circle_id, p, actor, String(action), at, signature, now(), text);
            db.prepare("UPDATE purchases SET status = 'confirmed', closed_at_ms = ? WHERE id = ?").run(now(), p.id);
          })();
        } else if (action === "cancelled") {
          if (isBuyer) {
            // the buyer may leave only while nothing has been released and the seller let the window pass without posting
            if (p.status !== "paid_held" && p.status !== "cipher_posted") refuse(`cancelled by the buyer only before the key is released, current state is ${p.status}`, { status: p.status });
            if (nowS <= Number(p.created_at_ms / 1000n) + window) refuse("the buyer may cancel only after the delivery window has ended", { windowSeconds: window });
          } else if (p.status !== "paid_held" && p.status !== "cipher_posted" && p.status !== "key_released") {
            refuse(`cancelled by the seller only before confirmation, current state is ${p.status}`, { status: p.status });
          }
          db.transaction(() => {
            record(db, circle.circle_id, p, actor, String(action), at, signature, now(), text);
            db.prepare("UPDATE purchases SET status = 'cancelled', closed_at_ms = ? WHERE id = ?").run(now(), p.id);
          })();
        } else {
          // disputed
          if (!isBuyer) notParty(actor, "Only the buyer may dispute");
          if (p.status !== "key_released") refuse(`disputed only from key_released, current state is ${p.status}`, { status: p.status });
          if (at > Number(p.dispute_until)) refuse("the dispute window has passed", { disputeUntil: Number(p.dispute_until) });
          if (typeof reason !== "string" || !(DISPUTE_REASONS as readonly string[]).includes(reason)) throw invalidRequest("reason is required: content_mismatch, contains_pii, or other", { allowed: [...DISPUTE_REASONS] });
          // ADR-48 points 5 to 7: for a code only a proof of cheating can stop the sale. "Used", "other" or "pii" without a proof is a complaint against the seller (one per purchase); the sale
          // goes on to the automatic confirmation, because nobody can tell who used a code and a buyer who holds a working code could otherwise keep it unpaid
          if (p.kind === "code" && reason !== "content_mismatch") {
            if (proof !== null) throw invalidRequest("proof is only for content_mismatch");
            const exists = row(db, "SELECT 1 AS x FROM purchase_complaints WHERE circle_id = ? AND purchase_id = ?", circle.circle_id, p.id);
            if (exists !== undefined) throw new ApiError(409, "already_exists", "This purchase already has a complaint", { purchaseId: p.id.toString() });
            db.transaction(() => {
              record(db, circle.circle_id, p, actor, "complained", at, signature, now(), text);
              db.prepare("INSERT INTO purchase_complaints (circle_id, purchase_id, seller, buyer, reason, at_s, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)").run(circle.circle_id, p.id, p.seller, p.buyer, reason, at, now());
            })();
            return { status: 201, body: { ...purchaseView(findPurchase(db, circle.circle_id, params.id as string)), complaint: true } };
          }
          let outcome: "disputed" | "refuted" = "disputed";
          if (reason === "content_mismatch") {
            // the proof is checked here, by the backend, against the ciphertext that the seller named
            const pr = proof as { release?: LicenseRelease; signature?: string; box_key?: string } | null;
            if (pr === null || typeof pr !== "object" || pr.release === undefined || typeof pr.signature !== "string" || typeof pr.box_key !== "string") {
              throw new ApiError(400, "proof_invalid", "content_mismatch requires proof {release, signature, box_key}", {});
            }
            if (JSON.stringify(pr.release) !== p.release_json || pr.signature !== p.release_signature) throw new ApiError(400, "proof_invalid", "proof must contain the release the seller issued for this purchase", {});
            const source: Source = { kind: p.source_kind as "https" | "ipfs", ref: p.source_ref as string };
            const sellerKey = activeMemberKey(db, circle.circle_id, p.seller);
            const purchaseId = p.id.toString();
            outcome = await withCiphertext(source, p.cipher_hash as string, (JSON.parse(p.release_json as string) as LicenseRelease).cipher_size, (ciphertext) =>
              checkCheatProof({ ciphertext, release: pr.release, signature: pr.signature, box_key: pr.box_key } as CheatProof, sellerKey, purchaseId).valid ? ("disputed" as const) : ("refuted" as const));
          } else if (proof !== null) {
            throw invalidRequest("proof is only for content_mismatch");
          }
          db.transaction(() => {
            record(db, circle.circle_id, p, actor, String(action), at, signature, now(), text);
            db.prepare("UPDATE purchases SET status = ?, dispute_reason = ?, closed_at_ms = ? WHERE id = ?").run(outcome, reason, now(), p.id);
          })();
        }
        return { status: 201, body: purchaseView(findPurchase(db, circle.circle_id, params.id as string)) };
      },
    },
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/listings/{hash}/takedown",
      circleScoped: true,
      handler: ({ db, circle, params, body, now }) => {
        const listing = findListing(db, circle.circle_id, params.hash as string);
        const { claim, evidence_hash: evidence, signature } = (body ?? {}) as { claim?: unknown; evidence_hash?: unknown; signature?: unknown };
        if (typeof claim !== "string" || claim.trim() === "" || claim.length > 2000) throw new ApiError(400, "takedown_invalid", "claim must be text of 1 to 2000 characters", {});
        if (typeof evidence !== "string" || (evidence !== "" && !HASH.test(evidence))) throw new ApiError(400, "takedown_invalid", "evidence_hash must be empty or 64 lowercase hex characters", {});
        if (typeof signature !== "string") throw invalidRequest("signature must be a string");
        const message = JSON.stringify({ circle: circle.contract_id, listing_hash: listing.listing_hash, claim, evidence_hash: evidence });
        // the body names no account, so the claimant is the active member whose voucher key signed the message
        const members = rows<{ account_id: string; pubkey_voucher: string }>(db, "SELECT account_id, pubkey_voucher FROM members WHERE circle_id = ? AND status = 'active'", circle.circle_id);
        const claimant = members.find((m) => verifyNoticeJson(message, circle.contract_id, signature, m.pubkey_voucher));
        if (!claimant) throw new ApiError(401, "invalid_signature", "Takedown signature does not match any active member's voucher key", {});
        if (claimant.account_id === listing.account_id) throw new ApiError(400, "takedown_invalid", "A seller does not file a takedown on their own listing; cancel the listing", {});
        // B7-C1: a buyer of this listing has his own routes (dispute, complaint, cancel); with a takedown he would cancel a sale after the key is out and keep what he got for nothing
        if (row(db, "SELECT 1 AS x FROM purchases WHERE circle_id = ? AND listing_hash = ? AND buyer = ? AND status <> 'cancelled'", circle.circle_id, listing.listing_hash, claimant.account_id)) {
          throw new ApiError(400, "takedown_invalid", "A buyer of this listing does not file a takedown on it; use the dispute or the complaint of the purchase", {});
        }
        if (row(db, "SELECT 1 AS x FROM takedowns WHERE circle_id = ? AND listing_hash = ?", circle.circle_id, listing.listing_hash)) throw new ApiError(409, "already_exists", "This listing is already taken down", {});
        // B7-C1: a code works once, so after the key is released nobody else's takedown may cancel the sale and leave the buyer with a working code and the seller unpaid
        const cancellable = detailOf(listing).kind === "code" ? "('paid_held','cipher_posted')" : "('paid_held','cipher_posted','key_released','disputed')";
        const cancelled = db.transaction(() => {
          db.prepare("UPDATE listings SET status = 'cancelled', closed_at_ms = ? WHERE circle_id = ? AND listing_hash = ? AND status IN ('open','matched')").run(now(), circle.circle_id, listing.listing_hash);
          // sales that are not confirmed are cancelled, so their vouchers never reach the seller; what is confirmed stays (ADR-20)
          const n = db
            .prepare(`UPDATE purchases SET status = 'cancelled', closed_at_ms = ? WHERE circle_id = ? AND listing_hash = ? AND status IN ${cancellable}`)
            .run(now(), circle.circle_id, listing.listing_hash).changes;
          db.prepare("INSERT INTO takedowns (circle_id, listing_hash, claimant, claim, evidence_hash, signature, cancelled_purchases, recorded_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(circle.circle_id, listing.listing_hash, claimant.account_id, claim, evidence, signature, n, now());
          return n;
        })();
        return { status: 201, body: { listingHash: listing.listing_hash, claimant: claimant.account_id, hidden: true, cancelledPurchases: cancelled, evidenceHash: evidence } };
      },
    },
  ];
}

/** `true` when the SHA-256 of `bytes` is the digest in the raw CID. */
