// BE-119: the attestation part of an appraisal. Two levels, reported apart so that nothing is claimed beyond what ran:
//   - binding (local, always): the report of NEAR AI Cloud names the signing address of the signature, echoes our fresh nonce,
//     and the TDX quote carries both in its `report_data` (`verify.ts`). This proves the report is fresh and about that key,
//     but NOT that the quote is genuine Intel hardware: the quote signature chain is not checked here.
//   - third-party quote checks (optional, `X207_APPRAISER_QUOTE_CHECK=1`):
//       TDX quote -> Phala public verifier `POST https://cloud-api.phala.network/api/v1/attestations/verify` ({hex}) -> `quote.verified`
//       GPU evidence -> NVIDIA NRAS `POST https://nras.attestation.nvidia.com/v3/attest/gpu` -> JWT claim `x-nvidia-overall-att-result`
//     Both are services run by other parties; x207 trusts their answer. The NRAS JWT signature is not checked here (claims are decoded only).
import { randomBytes } from "node:crypto";
import { NearAiCloud, CloudError } from "./cloud.js";
import { checkReportBinding, sha256Hex, tdxReportData, type AttestationReport, type ModelAttestation } from "./verify.js";

export const PHALA_VERIFY_URL = "https://cloud-api.phala.network/api/v1/attestations/verify";
export const NRAS_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";

export type ThirdPartyResult = "passed" | "failed" | "not_checked";

export interface AttestationSummary {
  model: string;
  signing_address: string;
  nonce: string;
  fetched_at: string;
  /** Local check: report names the key, echoes the nonce, TDX report_data = address || 0x00*12 || nonce. */
  report_binding: boolean;
  binding_reasons: string[];
  tdx_quote: ThirdPartyResult;
  tdx_quote_checked_by: string | null;
  gpu_evidence: ThirdPartyResult;
  gpu_evidence_checked_by: string | null;
  /** Hashes and identity of what was attested, so a reader can compare with a report fetched later. */
  intel_quote_sha256: string | null;
  nvidia_payload_sha256: string | null;
  tdx_report_data: string | null;
  app_id: string | null;
  compose_hash: string | null;
  os_image_hash: string | null;
  gateway_signing_address: string | null;
  attempts: number;
}

/**
 * The raw evidence of the report the summary was made from, exactly as NEAR AI Cloud returned it (the Intel TDX quote as hex, the
 * NVIDIA GPU evidence as the JSON text NRAS takes), so a third party can check the same quote and evidence again.
 */
export interface AttestationEvidence {
  nonce: string;
  intel_quote: string;
  nvidia_payload: string | null;
}

/** "checked" only when the binding holds and both third-party checks passed; "failed" when one of them said no. */
export function attestationVerdict(s: AttestationSummary): "checked" | "not_checked" | "failed" {
  if (!s.report_binding || s.tdx_quote === "failed" || s.gpu_evidence === "failed") return "failed";
  return s.tdx_quote === "passed" && s.gpu_evidence === "passed" ? "checked" : "not_checked";
}

export interface AttestationOptions {
  cloud: NearAiCloud;
  quoteCheck: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** A model is served by several TEE instances; a report shows one. Fetch again (new nonce) until it names our key. Default 4. */
  maxAttempts?: number;
  phalaUrl?: string;
  nrasUrl?: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

async function phalaCheck(doFetch: typeof fetch, url: string, quoteHex: string, expectedReportData: string): Promise<ThirdPartyResult> {
  try {
    const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hex: quoteHex }), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return "not_checked";
    const body = (await res.json()) as { quote?: { verified?: unknown; body?: { reportdata?: unknown } } };
    if (body.quote?.verified !== true) return "failed";
    const rd = String(body.quote.body?.reportdata ?? "").replace(/^0x/, "").toLowerCase();
    return rd === expectedReportData ? "passed" : "failed";
  } catch {
    return "not_checked";
  }
}

function jwtClaims(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function nrasCheck(doFetch: typeof fetch, url: string, payload: string, nonce: string): Promise<ThirdPartyResult> {
  try {
    const sent = JSON.parse(payload) as { nonce?: unknown };
    if (String(sent.nonce ?? "").toLowerCase() !== nonce.toLowerCase()) return "failed"; // the GPU evidence must be for our nonce
    const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return "not_checked";
    const body = (await res.json()) as unknown;
    const first = Array.isArray(body) && Array.isArray(body[0]) ? (body[0] as unknown[]) : null;
    const claims = first && first[0] === "JWT" && typeof first[1] === "string" ? jwtClaims(first[1]) : null;
    if (!claims) return "not_checked";
    if (claims["x-nvidia-overall-att-result"] !== true) return "failed";
    const eat = str(claims["eat_nonce"]);
    return eat === null || eat.toLowerCase() === nonce.toLowerCase() ? "passed" : "failed";
  } catch {
    return "not_checked";
  }
}

/** Fetches a fresh report (our nonce), checks the binding locally and, when enabled, the quote and the GPU evidence through third parties. */
export async function attest(model: string, signingAddress: string, opts: AttestationOptions): Promise<{ summary: AttestationSummary; evidence: AttestationEvidence | null }> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;
  const max = opts.maxAttempts ?? 4;
  let report: AttestationReport | null = null;
  let nonce = "";
  let binding = { ok: false, reasons: ["no report fetched"], attestation: null as ModelAttestation | null };
  let attempts = 0;
  for (; attempts < max && !binding.ok; ) {
    attempts += 1;
    nonce = randomBytes(32).toString("hex");
    try {
      report = await opts.cloud.attestation(model, nonce);
    } catch (err) {
      if (err instanceof CloudError && err.kind === "credits") throw err;
      binding = { ok: false, reasons: [err instanceof Error ? err.message : "attestation report failed"], attestation: null };
      continue;
    }
    binding = checkReportBinding(report, model, signingAddress, nonce);
    // another instance answered: only that is worth a new attempt
    if (!binding.ok && binding.attestation !== null) break;
  }
  const a = binding.attestation;
  const info = (a?.info ?? {}) as Record<string, unknown>;
  const summary: AttestationSummary = {
    model,
    signing_address: signingAddress.toLowerCase(),
    nonce,
    fetched_at: new Date(now()).toISOString(),
    report_binding: binding.ok,
    binding_reasons: binding.reasons,
    tdx_quote: "not_checked",
    tdx_quote_checked_by: null,
    gpu_evidence: "not_checked",
    gpu_evidence_checked_by: null,
    intel_quote_sha256: a?.intel_quote ? sha256Hex(a.intel_quote) : null,
    nvidia_payload_sha256: a?.nvidia_payload ? sha256Hex(a.nvidia_payload) : null,
    tdx_report_data: a?.intel_quote ? tdxReportData(a.intel_quote) : null,
    app_id: str(info.app_id),
    compose_hash: str(info.compose_hash),
    os_image_hash: str(info.os_image_hash),
    gateway_signing_address: str(report?.gateway_attestation?.signing_address),
    attempts,
  };
  if (opts.quoteCheck && binding.ok && a?.intel_quote && summary.tdx_report_data) {
    const phalaUrl = opts.phalaUrl ?? PHALA_VERIFY_URL;
    const nrasUrl = opts.nrasUrl ?? NRAS_URL;
    const [tdx, gpu] = await Promise.all([
      phalaCheck(doFetch, phalaUrl, a.intel_quote, summary.tdx_report_data),
      a.nvidia_payload ? nrasCheck(doFetch, nrasUrl, a.nvidia_payload, nonce) : Promise.resolve<ThirdPartyResult>("not_checked"),
    ]);
    summary.tdx_quote = tdx;
    summary.tdx_quote_checked_by = tdx === "not_checked" ? null : new URL(phalaUrl).host;
    summary.gpu_evidence = gpu;
    summary.gpu_evidence_checked_by = gpu === "not_checked" ? null : new URL(nrasUrl).host;
  }
  const evidence = a?.intel_quote ? { nonce, intel_quote: a.intel_quote, nvidia_payload: a.nvidia_payload ?? null } : null;
  return { summary, evidence };
}
