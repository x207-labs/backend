// BE-119: the checks behind an appraisal, with no network and no x207 state, so the server and `scripts/verify-appraisal.ts` run the same code.
//   1. the signed text of NEAR AI Cloud (`GET /v1/signature/{chat_id}`) is `<model>:<sha256(request body)>:<sha256(response body)>`;
//      the two hashes must equal the hashes of the bytes x207 sent and received;
//   2. the signature is an EIP-191 `personal_sign` (secp256k1) over that text; the recovered address must be the `signing_address`;
//   3. the attestation report of the model names the same `signing_address`, and the TDX quote of that report carries in its
//      `report_data` the signing address (20 bytes, then 12 zero bytes) and the nonce x207 asked with (32 bytes).
// What this file does NOT do: it does not check the Intel or NVIDIA signature chain of the quote (no DCAP here). That is done, when
// enabled, by `attestation.ts` through third-party verifiers, and reported as such.
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const sha256Hex = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const HEX = /^(?:0x)?[0-9a-fA-F]*$/;
function hexBytes(hex: string): Uint8Array {
  if (!HEX.test(hex) || hex.replace(/^0x/, "").length % 2 !== 0) throw new Error("not a hex string");
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));
}

/** Address (lowercase 0x + 40 hex) that produced an EIP-191 signature over `text`; `null` when the signature does not parse. */
export function recoverPersonalSignAddress(text: string, signatureHex: string): string | null {
  try {
    const msg = new TextEncoder().encode(text);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
    const joined = new Uint8Array(prefix.length + msg.length);
    joined.set(prefix, 0);
    joined.set(msg, prefix.length);
    const digest = keccak_256(joined);
    const raw = hexBytes(signatureHex);
    if (raw.length !== 65) return null;
    const v = raw[64]! >= 27 ? raw[64]! - 27 : raw[64]!;
    if (v !== 0 && v !== 1) return null;
    const recovered = new Uint8Array(65);
    recovered[0] = v;
    recovered.set(raw.subarray(0, 64), 1);
    const pub = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
    const full = secp256k1.Point.fromBytes(pub).toBytes(false);
    return "0x" + Buffer.from(keccak_256(full.subarray(1)).subarray(12)).toString("hex");
  } catch {
    return null;
  }
}

export interface SignatureCheck {
  ok: boolean;
  /** Why it failed; empty when `ok`. */
  reasons: string[];
  recovered_address: string | null;
}

/** Steps 1 and 2: the signed text binds this model and these bytes, and the signature comes from `signingAddress`. */
export function checkSignature(input: {
  model: string;
  requestHash: string;
  responseHash: string;
  text: string;
  signature: string;
  signingAddress: string;
}): SignatureCheck {
  const reasons: string[] = [];
  const expected = `${input.model}:${input.requestHash}:${input.responseHash}`;
  if (input.text !== expected) reasons.push("signed text does not match model:sha256(request):sha256(response)");
  const recovered = recoverPersonalSignAddress(input.text, input.signature);
  if (recovered === null) reasons.push("signature does not parse");
  else if (recovered !== input.signingAddress.toLowerCase()) reasons.push(`signature recovers to ${recovered}, not ${input.signingAddress.toLowerCase()}`);
  return { ok: reasons.length === 0, reasons, recovered_address: recovered };
}

/** The TD report body starts after the 48-byte quote header; `report_data` is its last 64 bytes (offset 520 in a TDX 1.0 body). */
const TDX_HEADER = 48;
const TDX_REPORT_DATA = 520;

/** `report_data` of a TDX v4 quote, hex; `null` when the quote is too short or not hex. */
export function tdxReportData(quoteHex: string): string | null {
  try {
    const q = hexBytes(quoteHex);
    if (q.length < TDX_HEADER + TDX_REPORT_DATA + 64) return null;
    return Buffer.from(q.subarray(TDX_HEADER + TDX_REPORT_DATA, TDX_HEADER + TDX_REPORT_DATA + 64)).toString("hex");
  } catch {
    return null;
  }
}

export interface ModelAttestation {
  model_name?: string;
  signing_address?: string;
  signing_algo?: string;
  request_nonce?: string;
  intel_quote?: string;
  nvidia_payload?: string;
  info?: Record<string, unknown>;
}

export interface AttestationReport {
  model_attestations?: ModelAttestation[];
  gateway_attestation?: { signing_address?: string; request_nonce?: string; intel_quote?: string };
}

export interface BindingCheck {
  ok: boolean;
  reasons: string[];
  /** The entry of `model_attestations` that names the signing address. */
  attestation: ModelAttestation | null;
}

/** Step 3: some model attestation of the report names `signingAddress` for `model`, echoes `nonce`, and its TDX quote binds both. */
export function checkReportBinding(report: AttestationReport, model: string, signingAddress: string, nonce: string): BindingCheck {
  const want = signingAddress.toLowerCase();
  const entry = (report.model_attestations ?? []).find((a) => (a.signing_address ?? "").toLowerCase() === want) ?? null;
  if (!entry) return { ok: false, reasons: [`no model attestation names ${want}`], attestation: null };
  const reasons: string[] = [];
  if (entry.model_name !== undefined && entry.model_name !== model) reasons.push(`attestation is for ${entry.model_name}, not ${model}`);
  if ((entry.request_nonce ?? "").toLowerCase() !== nonce.toLowerCase()) reasons.push("attestation does not echo the nonce x207 sent");
  const rd = entry.intel_quote ? tdxReportData(entry.intel_quote) : null;
  if (rd === null) reasons.push("no TDX quote, or the quote does not parse");
  else {
    const expected = want.replace(/^0x/, "") + "0".repeat(24) + nonce.toLowerCase();
    if (rd !== expected) reasons.push("TDX report_data is not signing_address || 12 zero bytes || nonce");
  }
  return { ok: reasons.length === 0, reasons, attestation: entry };
}
