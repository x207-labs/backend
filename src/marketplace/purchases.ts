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
  for (const key of ["license_doc", "content_hash"] as const) if (typeof d[key] !== "string" || !HASH.test(d[key] as string)) bad(`${key} harus 64 heksadesimal huruf kecil di detail listing lisensi`);
  if (typeof d.exclusive !== "boolean") bad("exclusive harus boolean di detail listing lisensi");
  if (typeof d.license_id !== "string" || !ids.some((i) => i.id === d.license_id)) {
    throw new ApiError(400, "license_id_rejected", "license_id tidak ada di daftar yang diterima", { licenseId: d.license_id ?? null, allowed: ids.map((i) => i.id) });
  }
  if (d.preview !== undefined) {
    if (typeof d.preview !== "string" || d.preview.length > 16_384) bad("preview harus teks paling banyak 16384 karakter");
    const preview = d.preview as string;
    if (typeof d.preview_hash === "string" && d.preview_hash !== sha256Hex(preview.trim())) bad("preview_hash harus sha256 dari preview");
    const found = scanPii(preview);
    if (found.length > 0) throw new ApiError(400, "preview_contains_pii", "Preview memuat data pribadi; pasang preview tanpa data pribadi", { kinds: found });
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
  if (typeof d.code_doc !== "string" || !HASH.test(d.code_doc)) bad("code_doc harus 64 heksadesimal huruf kecil di detail listing kode");
  if (d.identity_bound === true) throw new ApiError(400, "code_bound_to_identity", "Kode yang terikat pada identitas pemiliknya tidak bisa dijual", {});
  const doc: CodeDocument = { circle: l.circle as string, seller: l.account as string, code_commitment: d.code_commitment as string, issuer: d.issuer as string, value: l.offer?.value as string, verifiable: d.verifiable as boolean, arbiter: (d.arbiter as string | null | undefined) ?? null, nonce: d.nonce as string };
  try {
    const normal = checkCodeDocument(doc, options.codeUnverifiableLimit);
    if (codeDocumentHash(normal) !== d.code_doc) bad("code_doc bukan hash dokumen kode yang dibangun dari listing ini (circle, penjual, nilai, dan field detail)");
  } catch (error) {
    if (error instanceof CodeError) throw new ApiError(400, error.code as ApiErrorCode, error.message, {});
    throw error;
  }
  if (doc.verifiable && options.codeIssuers?.[doc.issuer] === undefined) throw new ApiError(400, "code_issuer_unknown", `penerbit ${doc.issuer} tidak terdaftar di backend ini`, { issuer: doc.issuer });
};

function detailOf(listing: ListingRow): LicenseDetail & { kind: "license" | "code" } {
  const code = codeDetail(listing.detail);
  if (code !== null && typeof code.code_doc === "string" && typeof code.code_commitment === "string") {
    return { kind: "code", license_doc: code.code_doc, content_hash: code.code_commitment, license_id: "one-time-code", license_hash: null, exclusive: true };
  }
  const d = licenseDetail(listing.detail);
  if (d === null || typeof d.license_doc !== "string" || typeof d.content_hash !== "string" || typeof d.license_id !== "string" || typeof d.exclusive !== "boolean") {
    throw new ApiError(409, "listing_not_open", "Listing ini bukan listing lisensi", { listingHash: listing.listing_hash });
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
  if (!found) throw new ApiError(404, "purchase_not_found", `Pembelian ${id} tidak ada`, { purchaseId: id });
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
  if (s === null || typeof s !== "object" || (s.kind !== "https" && s.kind !== "ipfs") || typeof s.ref !== "string") throw invalidRequest("source harus {kind: https atau ipfs, ref}");
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
    if (c === undefined || nowMs - Number(c.checked_at_ms) > checkTtlMs) throw new ApiError(409, "code_not_checked", "Kode ini harus dicek ke penerbit dulu (POST …/code-check) sebelum kunci dilepas; hasil cek berlaku sebentar", { ttlSeconds: checkTtlMs / 1000 });
    if (c.verdict === "used") {
      cancelCodeSale(db, circleId, p.listing_hash, nowMs);
      throw new ApiError(409, "code_used", "Penerbit menyatakan kode ini sudah terpakai; pembelian dibatalkan dan voucher tidak berpindah", {});
    }
    if (c.verdict !== "valid") throw new ApiError(409, "code_unknown", "Penerbit tidak mengenal kode ini; kunci tidak dilepas", {});
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
    if (!res.reachable || res.status < 200 || res.status >= 300) refuse("Sumber tidak menjawab dengan sukses (HEAD)", { kind: source.kind, status: res.reachable ? res.status : null });
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
      if (!res.reachable || res.status !== 200) refuse("Ciphertext tidak bisa diunduh dari sumber", { kind: source.kind, status: res.reachable ? res.status : null });
      if (source.kind === "ipfs" && !Buffer.from(parseRawCid(source.ref).digest).equals(plain.digest())) throw new ApiError(400, "proof_invalid", "Byte dari gateway tidak cocok dengan CID", {});
      // the size is signed in the release (review BE-062 F1): a body of another size is refused before the hash is even compared, so the 65-byte body of a Merkle node never counts
      if (received !== cipherSize) throw new ApiError(400, "proof_invalid", `Sumber menyajikan ${received} byte, rilis menandatangani ${cipherSize}`, {});
      if (hasher.digest() !== cipherHash) throw new ApiError(400, "proof_invalid", "Sumber tidak lagi menyajikan ciphertext dengan cipher_hash yang dipasang", {});
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
    if (inserted.changes === 0) throw new ApiError(409, "already_exists", "Notice ini sudah tercatat", {});
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
        if (cd === null || typeof cd.code_commitment !== "string") throw new ApiError(409, "listing_not_open", "Listing ini bukan listing kode", { listingHash: listing.listing_hash });
        if (listing.status !== "open" || Number(listing.expires_at) <= nowS) throw new ApiError(409, "listing_not_open", "Listing tidak terbuka", { listingHash: listing.listing_hash, status: listing.status });
        if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
        const { notice, signature, code, salt } = body as { notice?: Record<string, unknown>; signature?: unknown; code?: unknown; salt?: unknown };
        if (typeof signature !== "string") throw invalidRequest("signature wajib string");
        if (notice === null || typeof notice !== "object") throw invalidRequest("notice wajib objek");
        // keys: circle, listing_hash, actor, action, at; action is "check". The signature covers the listing, so a check of one listing cannot be shown for another.
        if (Object.keys(notice).join(",") !== "circle,listing_hash,actor,action,at") throw invalidRequest("kunci notice harus circle, listing_hash, actor, action, at (urutan tetap)");
        if (notice.circle !== circle.contract_id) throw invalidRequest("notice.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: notice.circle });
        if (notice.listing_hash !== listing.listing_hash || notice.action !== "check") throw invalidRequest("notice.listing_hash harus listing ini dan action harus check");
        if (!Number.isSafeInteger(notice.at) || Math.abs((notice.at as number) - nowS) > NOTICE_SKEW_SECONDS) throw invalidRequest(`notice.at harus detik unix dalam ${NOTICE_SKEW_SECONDS} detik dari jam server`);
        if (notice.actor !== listing.account_id) throw new ApiError(403, "purchase_not_party", "Hanya penjual yang menunjukkan kodenya untuk dicek", { actor: notice.actor });
        if (!verifyNoticeJson(JSON.stringify(notice), circle.contract_id, signature, activeMemberKey(db, circle.circle_id, listing.account_id))) {
          throw new ApiError(401, "invalid_signature", "Tanda tangan notice tidak cocok dengan kunci penjual", { account: listing.account_id });
        }
        // from here on nothing that holds the code or the salt may reach a message, a detail, a log or a table
        if (typeof code !== "string" || typeof salt !== "string" || !HASH.test(salt)) throw invalidRequest("code (teks) dan salt (64 heksadesimal huruf kecil) wajib");
        let commitment: string;
        try {
          commitment = codeCommitment(code, Uint8Array.from(Buffer.from(salt, "hex")));
        } catch (error) {
          if (error instanceof CodeError) throw new ApiError(400, error.code as ApiErrorCode, "kode tidak sah (panjang atau karakter)", {});
          throw error;
        }
        if (commitment !== cd.code_commitment) throw new ApiError(400, "code_bad_commitment", "salt dan kode tidak cocok dengan code_commitment listing", {});
        if (cd.verifiable !== true) throw new ApiError(400, "code_not_verifiable", "Penerbit kode ini tidak punya cek; tidak ada yang dicek", { issuer: cd.issuer });
        const issuer = options.codeIssuers?.[String(cd.issuer)];
        if (issuer === undefined) throw new ApiError(400, "code_issuer_unknown", `penerbit ${String(cd.issuer)} tidak terdaftar di backend ini`, { issuer: cd.issuer });
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
          if (other !== undefined) throw new ApiError(409, "code_duplicate", "Kode yang sama sudah ada di listing lain yang terbuka atau sudah terjual", { otherListing: other.listing_hash });
        }
        let verdict: "valid" | "used" | "unknown";
        try {
          verdict = await issuer.checkCode(code);
        } catch {
          throw new ApiError(503, "code_issuer_unavailable", "Penerbit tidak menjawab; belum ada keputusan, coba lagi", { issuer: cd.issuer });
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
        if (cd === null) throw new ApiError(409, "listing_not_open", "Listing ini bukan listing kode", { listingHash: listing.listing_hash });
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
        if (contentFilter !== null && !HASH.test(contentFilter)) throw invalidRequest("content_hash harus 64 heksadesimal huruf kecil");
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
        if (listing.status !== "open" || Number(listing.expires_at) <= nowSeconds(now())) throw new ApiError(409, "listing_not_open", "Listing tidak terbuka", { listingHash: listing.listing_hash, status: listing.status });
        const d = detailOf(listing);
        const { voucher, signature } = (body ?? {}) as { voucher?: Record<string, unknown>; signature?: unknown };
        if (voucher === null || typeof voucher !== "object" || typeof signature !== "string") throw invalidRequest("voucher dan signature wajib");
        const v = voucher as unknown as UnsignedVoucher;
        if (v.circle !== circle.contract_id) throw invalidRequest("voucher.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: v.circle });
        if (v.payee !== listing.account_id) throw invalidRequest("voucher.payee harus penjual listing", { expected: listing.account_id });
        if (v.payer === v.payee) throw invalidRequest("pembeli tidak boleh penjual");
        const expectedResource = d.kind === "code" ? codeResource(d.license_doc) : licenseResource(d.license_doc);
        if (v.resource !== expectedResource) throw invalidRequest(d.kind === "code" ? "voucher.resource harus x207:code:<code_doc>" : "voucher.resource harus x207:license:<license_doc>", { expected: expectedResource });
        const key = activeMemberKey(db, circle.circle_id, v.payer);
        if (!verifyVoucher({ ...v, signature } as Voucher, key)) throw new ApiError(401, "invalid_signature", "Tanda tangan voucher tidak cocok dengan kunci voucher pembeli", { account: v.payer });
        const open = await resolveOpenEpoch(db, circle);
        if (open === null || v.epoch !== open) throw new ApiError(409, "epoch_not_open", "Voucher harus untuk epoch open saat ini", { expected: open, got: v.epoch });
        const state = row<{ seq: bigint; cumulative_amount: bigint }>(db, "SELECT seq, cumulative_amount FROM obligations WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?", circle.circle_id, v.epoch, v.payer, v.payee);
        const price = BigInt(listing.offer_value);
        if (BigInt(v.seq) <= (state?.seq ?? 0n) || BigInt(v.cumulativeAmount) - (state?.cumulative_amount ?? 0n) < price) {
          throw invalidRequest("voucher harus melanjutkan keadaan pasangan (seq naik) dan menambah paling sedikit harga listing", { price: price.toString() });
        }
        // exclusivity per content hash: an exclusive license excludes every other, and nothing is sold exclusively while another license of that content is alive
        const clash = row<{ n: bigint }>(
          db,
          `SELECT COUNT(*) AS n FROM purchases WHERE circle_id = ? AND content_hash = ? AND status IN ${ACTIVE} AND (? = 1 OR exclusive = 1)`,
          circle.circle_id, d.content_hash, d.exclusive ? 1 : 0,
        );
        if ((clash?.n ?? 0n) > 0n) throw new ApiError(409, "exclusive_taken", "Isi ini sudah punya lisensi eksklusif, atau lisensi lain yang menghalangi lisensi eksklusif", { contentHash: d.content_hash });
        assertOpenRoom(db, "SELECT COUNT(*) AS n FROM purchases WHERE circle_id = ? AND buyer = ? AND status IN ('paid_held','cipher_posted','key_released','disputed')", [circle.circle_id, v.payer], options.openLimits?.purchases ?? DEFAULT_OPEN.purchases, "pembelian", v.payer);
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
        if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
        const { notice, signature } = body as { notice?: Record<string, unknown>; signature?: unknown };
        if (typeof signature !== "string") throw invalidRequest("signature wajib string");
        if (notice === null || typeof notice !== "object") throw invalidRequest("notice wajib objek");
        const skew = (at: unknown): number => {
          if (!Number.isSafeInteger(at) || (at as number) < 1) throw invalidRequest("at harus detik unix bulat");
          if (Math.abs((at as number) - nowS) > NOTICE_SKEW_SECONDS) throw invalidRequest(`notice.at menyimpang lebih dari ${NOTICE_SKEW_SECONDS} detik dari jam server`, { at, now: nowS });
          return at as number;
        };

        // ---- key_released: the notice is the release of the SDK, signed with the signing of the SDK
        if (typeof notice.sealed_key === "string") {
          const r = notice as unknown as LicenseRelease;
          if (p.status !== "cipher_posted") refuse(`key_released hanya dari cipher_posted, keadaan sekarang ${p.status}`, { status: p.status });
          const at = skew(r.at);
          const d = (row<{ detail: string }>(db, "SELECT detail FROM listings WHERE circle_id = ? AND listing_hash = ?", circle.circle_id, p.listing_hash)?.detail ?? "");
          const detail = licenseDetail(d);
          if (r.circle !== circle.contract_id || r.buyer !== p.buyer || r.cipher_hash !== p.cipher_hash || r.content_hash !== p.content_hash) {
            throw invalidRequest("rilis harus untuk lingkaran, pembeli, cipher_hash, dan content_hash pembelian ini");
          }
          // the release names the purchase it serves (review BE-062 F12), its sizes (F1) and the commitment to the key (F11)
          if (r.purchase_id !== p.id.toString()) throw invalidRequest("release.purchase_id harus id pembelian ini", { expected: p.id.toString(), got: r.purchase_id ?? null });
          if (!Number.isSafeInteger(r.content_size) || !Number.isSafeInteger(r.cipher_size) || r.content_size < 0 || r.cipher_size < 1) throw invalidRequest("release.content_size dan release.cipher_size harus bilangan bulat (cipher_size > 0)");
          if (typeof r.key_commitment !== "string" || !HASH.test(r.key_commitment)) throw invalidRequest("release.key_commitment harus 64 heksadesimal huruf kecil");
          if (r.license_hash !== p.license_doc && r.license_hash !== detail?.license_hash) throw invalidRequest("release.license_hash harus license_doc atau license_hash dari listing");
          if (!verifyRelease(r, signature, activeMemberKey(db, circle.circle_id, p.seller))) throw new ApiError(401, "invalid_signature", "Tanda tangan rilis tidak cocok dengan kunci penjual", { account: p.seller });
          // a code is short: the payload is a salt of 32 bytes and at most 1024 bytes of code, so a seller cannot ship the buyer a "code" of a gigabyte or a wall of control characters (B6-F5)
          if (p.kind === "code" && (r.content_size < 32 + 8 || r.content_size > 32 + 1024 || r.cipher_size > r.content_size + 64)) {
            throw invalidRequest("kode: content_size harus 40 sampai 1056 byte (salt 32 + kode 8 sampai 1024) dan cipher_size paling banyak content_size + 64", { contentSize: r.content_size, cipherSize: r.cipher_size });
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
        if (typeof actor !== "string" || !ACCOUNT.test(actor)) throw invalidRequest("notice.actor harus account id");
        if (notice.circle !== circle.contract_id) throw invalidRequest("notice.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: notice.circle });
        if (notice.purchase_id !== p.id.toString()) throw invalidRequest("notice.purchase_id harus id pembelian ini", { expected: p.id.toString() });
        if (actor !== p.buyer && actor !== p.seller) notParty(actor, "Hanya pembeli atau penjual yang boleh mengirim notice");
        const at = skew(notice.at);
        const action = notice.action;

        if (action === "cipher_posted") {
          // keys: circle, purchase_id, actor, action, at, source, cipher_hash
          if (actor !== p.seller) notParty(actor, "Hanya penjual yang memasang ciphertext");
          if (p.status !== "paid_held" && p.status !== "cipher_posted") refuse(`cipher_posted hanya dari paid_held, keadaan sekarang ${p.status}`, { status: p.status });
          if (typeof notice.cipher_hash !== "string" || !HASH.test(notice.cipher_hash)) throw invalidRequest("cipher_hash harus 64 heksadesimal huruf kecil");
          const source = parseSource(notice.source);
          const text = JSON.stringify({ circle: notice.circle, purchase_id: notice.purchase_id, actor, action, at, source: { kind: source.kind, ref: source.ref }, cipher_hash: notice.cipher_hash });
          if (!verifyNoticeJson(text, circle.contract_id, signature, activeMemberKey(db, circle.circle_id, actor))) throw new ApiError(401, "invalid_signature", "Tanda tangan notice tidak cocok dengan kunci penjual", { account: actor });
          await checkAvailable(source);
          db.transaction(() => {
            record(db, circle.circle_id, p, actor, String(action), at, signature, now(), text);
            db.prepare("UPDATE purchases SET status = 'cipher_posted', source_kind = ?, source_ref = ?, cipher_hash = ? WHERE id = ?").run(source.kind, source.ref, notice.cipher_hash, p.id);
          })();
          return { status: 201, body: purchaseView(findPurchase(db, circle.circle_id, params.id as string)) };
        }

        // ---- confirmed, disputed, cancelled: keys circle, purchase_id, actor, action, at, reason, proof (the format of FE-028)
        if (!(BUYER_ACTIONS as readonly unknown[]).includes(action)) throw invalidRequest("action tidak dikenal", { allowed: ["cipher_posted", "key_released", ...BUYER_ACTIONS] });
        const reason = notice.reason ?? null;
        const proof = notice.proof ?? null;
        const keys = Object.keys(notice).join(",");
        if (keys !== "circle,purchase_id,actor,action,at,reason,proof") throw invalidRequest("kunci notice harus circle, purchase_id, actor, action, at, reason, proof (urutan tetap)");
        const text = JSON.stringify(notice);
        if (!verifyNoticeJson(text, circle.contract_id, signature, activeMemberKey(db, circle.circle_id, actor))) throw new ApiError(401, "invalid_signature", "Tanda tangan notice tidak cocok dengan kunci voucher anggota", { account: actor });
        const isBuyer = actor === p.buyer;

        if (action === "confirmed") {
          if (!isBuyer) notParty(actor, "Hanya pembeli yang mengonfirmasi");
          if (p.status !== "key_released") refuse(`confirmed hanya dari key_released, keadaan sekarang ${p.status}`, { status: p.status });
          db.transaction(() => {
            record(db, circle.circle_id, p, actor, String(action), at, signature, now(), text);
            db.prepare("UPDATE purchases SET status = 'confirmed', closed_at_ms = ? WHERE id = ?").run(now(), p.id);
          })();
        } else if (action === "cancelled") {
          if (isBuyer) {
            // the buyer may leave only while nothing has been released and the seller let the window pass without posting
            if (p.status !== "paid_held" && p.status !== "cipher_posted") refuse(`cancelled dari pembeli hanya sebelum kunci dilepas, keadaan sekarang ${p.status}`, { status: p.status });
            if (nowS <= Number(p.created_at_ms / 1000n) + window) refuse("pembeli baru boleh membatalkan setelah jendela pengiriman berakhir", { windowSeconds: window });
          } else if (p.status !== "paid_held" && p.status !== "cipher_posted" && p.status !== "key_released") {
            refuse(`cancelled dari penjual hanya sebelum konfirmasi, keadaan sekarang ${p.status}`, { status: p.status });
          }
          db.transaction(() => {
            record(db, circle.circle_id, p, actor, String(action), at, signature, now(), text);
            db.prepare("UPDATE purchases SET status = 'cancelled', closed_at_ms = ? WHERE id = ?").run(now(), p.id);
          })();
        } else {
          // disputed
          if (!isBuyer) notParty(actor, "Hanya pembeli yang menyengketakan");
          if (p.status !== "key_released") refuse(`disputed hanya dari key_released, keadaan sekarang ${p.status}`, { status: p.status });
          if (at > Number(p.dispute_until)) refuse("jendela sengketa sudah lewat", { disputeUntil: Number(p.dispute_until) });
          if (typeof reason !== "string" || !(DISPUTE_REASONS as readonly string[]).includes(reason)) throw invalidRequest("reason wajib: content_mismatch, contains_pii, atau other", { allowed: [...DISPUTE_REASONS] });
          let outcome: "disputed" | "refuted" = "disputed";
          if (reason === "content_mismatch") {
            // the proof is checked here, by the backend, against the ciphertext that the seller named
            const pr = proof as { release?: LicenseRelease; signature?: string; box_key?: string } | null;
            if (pr === null || typeof pr !== "object" || pr.release === undefined || typeof pr.signature !== "string" || typeof pr.box_key !== "string") {
              throw new ApiError(400, "proof_invalid", "content_mismatch wajib membawa proof {release, signature, box_key}", {});
            }
            if (JSON.stringify(pr.release) !== p.release_json || pr.signature !== p.release_signature) throw new ApiError(400, "proof_invalid", "proof harus memuat rilis yang dilepas penjual untuk pembelian ini", {});
            const source: Source = { kind: p.source_kind as "https" | "ipfs", ref: p.source_ref as string };
            const sellerKey = activeMemberKey(db, circle.circle_id, p.seller);
            const purchaseId = p.id.toString();
            outcome = await withCiphertext(source, p.cipher_hash as string, (JSON.parse(p.release_json as string) as LicenseRelease).cipher_size, (ciphertext) =>
              checkCheatProof({ ciphertext, release: pr.release, signature: pr.signature, box_key: pr.box_key } as CheatProof, sellerKey, purchaseId).valid ? ("disputed" as const) : ("refuted" as const));
          } else if (proof !== null) {
            throw invalidRequest("proof hanya untuk content_mismatch");
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
        if (typeof claim !== "string" || claim.trim() === "" || claim.length > 2000) throw new ApiError(400, "takedown_invalid", "claim wajib teks 1 sampai 2000 karakter", {});
        if (typeof evidence !== "string" || (evidence !== "" && !HASH.test(evidence))) throw new ApiError(400, "takedown_invalid", "evidence_hash harus kosong atau 64 heksadesimal huruf kecil", {});
        if (typeof signature !== "string") throw invalidRequest("signature wajib string");
        const message = JSON.stringify({ circle: circle.contract_id, listing_hash: listing.listing_hash, claim, evidence_hash: evidence });
        // the body names no account, so the claimant is the active member whose voucher key signed the message
        const members = rows<{ account_id: string; pubkey_voucher: string }>(db, "SELECT account_id, pubkey_voucher FROM members WHERE circle_id = ? AND status = 'active'", circle.circle_id);
        const claimant = members.find((m) => verifyNoticeJson(message, circle.contract_id, signature, m.pubkey_voucher));
        if (!claimant) throw new ApiError(401, "invalid_signature", "Tanda tangan takedown tidak cocok dengan kunci voucher anggota aktif mana pun", {});
        if (claimant.account_id === listing.account_id) throw new ApiError(400, "takedown_invalid", "Penjual tidak mengajukan takedown atas listingnya sendiri; batalkan listing", {});
        if (row(db, "SELECT 1 AS x FROM takedowns WHERE circle_id = ? AND listing_hash = ?", circle.circle_id, listing.listing_hash)) throw new ApiError(409, "already_exists", "Listing ini sudah di-takedown", {});
        const cancelled = db.transaction(() => {
          db.prepare("UPDATE listings SET status = 'cancelled', closed_at_ms = ? WHERE circle_id = ? AND listing_hash = ? AND status IN ('open','matched')").run(now(), circle.circle_id, listing.listing_hash);
          // sales that are not confirmed are cancelled, so their vouchers never reach the seller; what is confirmed stays (ADR-20)
          const n = db
            .prepare("UPDATE purchases SET status = 'cancelled', closed_at_ms = ? WHERE circle_id = ? AND listing_hash = ? AND status IN ('paid_held','cipher_posted','key_released','disputed')")
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
