// BE-119: the x207 appraiser. A model on NEAR AI Cloud (private inference in a TEE) prices one barter asset with a fixed rubric; x207 keeps the
// signature of the TEE over the exact request and response bytes, checks it, and checks a fresh attestation report of the model.
//   POST /x207/appraise              body: the asset (see `assetOf`)                     -> 201 the appraisal with its evidence (200 when cached)
//   GET  /x207/appraisals/{appraisal}                                                     -> the appraisal with all its evidence
// What an appraisal is and is not (also in the README):
//   - advice only: the parties of the barter still agree on the price; the circle contract does not read the appraisal;
//   - `verified.signature` is a local check (sha256 of the bytes + secp256k1 recovery); `verified.attestation` is "checked" only when the
//     report binding holds AND the third-party verifiers (Phala for the TDX quote, NVIDIA NRAS for the GPU) said yes; otherwise
//     "not_checked" (they did not run) or "failed";
//   - the gap of headroom across facilitators is not closed by this.
// Limits: the key is only in the env of the server; per address per day and for everybody per day (only calls that reach NEAR AI Cloud count;
// a cached answer is free); the body is at most 4 KiB; the same asset (same rubric, same model) is answered from the database.
import type Database from "better-sqlite3";
import { ApiError, invalidRequest } from "../api/errors.js";
import { rateLimited } from "../api/abuse.js";
import { isoFromMs, row } from "../api/format.js";
import type { Route } from "../api/router.js";
import { migrate } from "../db/migrate.js";
import { MARKETPLACE_MIGRATIONS } from "../marketplace/migrations.js";
import { attest, attestationVerdict, type AttestationSummary } from "./attestation.js";
import { CloudError, DEFAULT_CLOUD_URL, NearAiCloud, parseJson } from "./cloud.js";
import { RUBRIC_HASH, RUBRIC_VERSION, SYSTEM_PROMPT, parseAppraisal, type AppraisalResult } from "./rubric.js";
import { checkSignature, sha256Hex } from "./verify.js";

const DAY_MS = 86_400_000;
const STALE_PENDING_MS = 5 * 60_000;
export const MAX_BODY_BYTES = 4096;
export const APPRAISAL_ID = /^apr_[0-9a-f]{24}$/;

/** Models that serve from NEAR AI Cloud TEEs with a per-chat ECDSA signature and accept `temperature` (checked in the spike of 2026-11-12). USD per million tokens, in / out. */
export const APPRAISER_MODELS: Record<string, { in: number; out: number }> = {
  "z-ai/glm-5.3-flash": { in: 0.08, out: 0.5 },
  "Qwen/Qwen3.8-27B": { in: 0.04, out: 1.35 },
  "Qwen/Qwen3.6-35B-A3B-FP8": { in: 0.17, out: 1.1 },
};
/** Qwen3.6-35B-A3B-FP8 honours `enable_thinking: false` (about 2 s per appraisal); glm-5.3-flash ignored it on 2026-11-12 and spent all 600 tokens reasoning (about 50 s, no answer). */
export const DEFAULT_APPRAISER_MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";

export interface AppraiserConfig {
  /** `undefined` when no key is set: the GET still serves stored appraisals, the POST answers 503 `appraiser_disabled`. */
  cloud: NearAiCloud | undefined;
  model: string;
  perIpPerDay: number;
  perDay: number;
  /** Ask Phala (TDX quote) and NVIDIA NRAS (GPU evidence) to check the attestation. */
  quoteCheck: boolean;
  maxTokens: number;
  fetch?: typeof fetch;
  /** Wait between attempts to fetch the signature (it can lag the answer by a moment). */
  signatureRetryMs?: number;
  phalaUrl?: string;
  nrasUrl?: string;
}

export const APPRAISER_DEFAULTS = { perIpPerDay: 20, perDay: 200, quoteCheck: true, maxTokens: 600 } as const;

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  return Number(raw);
}

/** Env: `X207_APPRAISER_NEARAI_KEY` (fallback `NEARAI_API_KEY`), `X207_APPRAISER_MODEL`, `X207_APPRAISER_BASE_URL`, `X207_APPRAISER_PER_IP_PER_DAY`,
 *  `X207_APPRAISER_PER_DAY`, `X207_APPRAISER_QUOTE_CHECK` (`0` turns the third-party checks off), `X207_APPRAISER_MAX_TOKENS`, `X207_APPRAISER_TIMEOUT_MS`. */
export function appraiserFromEnv(env: NodeJS.ProcessEnv = process.env): AppraiserConfig {
  const model = env.X207_APPRAISER_MODEL || DEFAULT_APPRAISER_MODEL;
  if (!APPRAISER_MODELS[model]) throw new Error(`X207_APPRAISER_MODEL must be one of ${Object.keys(APPRAISER_MODELS).join(", ")}`);
  const apiKey = env.X207_APPRAISER_NEARAI_KEY || env.NEARAI_API_KEY || "";
  const cloud = apiKey
    ? new NearAiCloud({ apiKey, baseUrl: env.X207_APPRAISER_BASE_URL || DEFAULT_CLOUD_URL, timeoutMs: positiveInt(env.X207_APPRAISER_TIMEOUT_MS, 60_000, "X207_APPRAISER_TIMEOUT_MS") })
    : undefined;
  return {
    cloud,
    model,
    perIpPerDay: positiveInt(env.X207_APPRAISER_PER_IP_PER_DAY, APPRAISER_DEFAULTS.perIpPerDay, "X207_APPRAISER_PER_IP_PER_DAY"),
    perDay: positiveInt(env.X207_APPRAISER_PER_DAY, APPRAISER_DEFAULTS.perDay, "X207_APPRAISER_PER_DAY"),
    quoteCheck: env.X207_APPRAISER_QUOTE_CHECK !== "0",
    maxTokens: positiveInt(env.X207_APPRAISER_MAX_TOKENS, APPRAISER_DEFAULTS.maxTokens, "X207_APPRAISER_MAX_TOKENS"),
  };
}

export interface AppraisalAsset {
  asset_type: string;
  asset_class: "A" | "B" | "C" | "D";
  quantity: number;
  scope: string;
  duration_days: number | null;
  provider: string;
  market_price_credits: string | null;
  description: string;
}

const ASSET_FIELDS = ["asset_type", "asset_class", "quantity", "scope", "duration_days", "provider", "market_price_credits", "description"] as const;
const PRINTABLE = /^[\x20-\x7e]*$/;

const badAsset = (field: string, message: string): never => {
  throw new ApiError(400, "appraiser_bad_asset", message, { field });
};

function text(v: unknown, field: string, max: number, required: boolean): string {
  if (v === undefined || v === null) return required ? badAsset(field, `${field} is required`) : "";
  if (typeof v !== "string" || v.length > max || !PRINTABLE.test(v)) return badAsset(field, `${field} must be printable ASCII text of at most ${max} characters`);
  if (required && v.trim() === "") return badAsset(field, `${field} is required`);
  return v.trim();
}

/** The asset in the shape of the listings of the book (`asset_type`, `asset_class`, `quantity`) plus what a price needs (scope, duration, provider, market price). */
export function assetOf(body: unknown): AppraisalAsset {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw invalidRequest("body must be a JSON object");
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", `the asset must be at most ${MAX_BODY_BYTES} bytes`, { limit: MAX_BODY_BYTES });
  const b = body as { asset_type?: unknown; asset_class?: unknown; quantity?: unknown; scope?: unknown; duration_days?: unknown; provider?: unknown; market_price_credits?: unknown; description?: unknown };
  const unknown = Object.keys(b).filter((k) => !(ASSET_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) throw invalidRequest(`unknown field ${unknown[0]}`, { field: unknown[0] });
  const assetType = text(b.asset_type, "asset_type", 64, true);
  if (!/^[a-z0-9][a-z0-9_.:-]*$/.test(assetType)) badAsset("asset_type", "asset_type must be lowercase letters, digits and _ . : -");
  const cls = b.asset_class;
  if (cls !== "A" && cls !== "B" && cls !== "C" && cls !== "D") return badAsset("asset_class", "asset_class must be A, B, C or D");
  const quantity = b.quantity === undefined ? 1 : b.quantity;
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000_000) return badAsset("quantity", "quantity must be an integer from 1 to 1000000000");
  const duration = b.duration_days === undefined ? null : b.duration_days;
  if (duration !== null && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 || duration > 3650)) return badAsset("duration_days", "duration_days must be a number from 0 to 3650, or null");
  let market: string | null = null;
  if (b.market_price_credits !== undefined && b.market_price_credits !== null) {
    const raw = b.market_price_credits;
    const ok = (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) || (typeof raw === "string" && /^\d{1,9}(\.\d{1,6})?$/.test(raw));
    if (!ok) return badAsset("market_price_credits", "market_price_credits must be a non-negative amount of credit with at most 6 decimals");
    market = (Math.round(Number(raw) * 1e6) / 1e6).toString();
  }
  return {
    asset_type: assetType,
    asset_class: cls,
    quantity,
    scope: text(b.scope, "scope", 300, true),
    duration_days: duration,
    provider: text(b.provider, "provider", 100, true),
    market_price_credits: market,
    description: text(b.description, "description", 1000, false),
  };
}

/** Canonical JSON of the asset: the keys in the fixed order of `ASSET_FIELDS`. */
export const canonicalAsset = (a: AppraisalAsset): string => JSON.stringify(Object.fromEntries(ASSET_FIELDS.map((k) => [k, a[k]])));

/** The exact bytes sent to NEAR AI Cloud: temperature 0, no reasoning, JSON output. Deterministic for the same asset, model and rubric. */
export function chatRequestBody(asset: AppraisalAsset, model: string, maxTokens: number): string {
  return JSON.stringify({
    model,
    temperature: 0,
    max_tokens: maxTokens,
    chat_template_kwargs: { enable_thinking: false },
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Asset to appraise (JSON data):\n${canonicalAsset(asset)}` },
    ],
  });
}

interface AppraisalRow {
  appraisal_id: string;
  input_hash: string;
  state: "pending" | "done";
  asset_json: string;
  model: string;
  rubric_version: string;
  rubric_hash: string;
  request_body: string | null;
  response_body: string | null;
  request_hash: string | null;
  response_hash: string | null;
  chat_id: string | null;
  result_json: string | null;
  signed_text: string | null;
  signature: string | null;
  signing_address: string | null;
  signing_algo: string | null;
  signature_kind: string | null;
  signature_ok: bigint | null;
  signature_reasons: string | null;
  attestation_json: string | null;
  attestation_verdict: string | null;
  usage_json: string | null;
  cost_usd: string | null;
  created_at_ms: bigint;
  completed_at_ms: bigint | null;
}

export const NOTES = [
  "Advice only: the parties of the barter still agree on the price.",
  "The x207 circle contract does not read this appraisal.",
  "verified.signature is checked by x207: sha256 of the stored request and response bytes, and secp256k1 recovery of the TEE signature over model:request_hash:response_hash.",
  "verified.attestation is 'checked' only when the attestation report binds the signing address and a fresh nonce AND the third-party verifiers (Phala for the Intel TDX quote, NVIDIA NRAS for the GPU evidence) both passed. x207 does not run Intel DCAP itself.",
  "This does not close the headroom gap across facilitators.",
  "Re-check without x207: node scripts/verify-appraisal.ts <url of this appraisal>.",
];

function view(r: AppraisalRow, cached: boolean) {
  const attestation = r.attestation_json ? (JSON.parse(r.attestation_json) as AttestationSummary) : null;
  const usage = r.usage_json ? (JSON.parse(r.usage_json) as Record<string, unknown>) : null;
  return {
    appraisal_id: r.appraisal_id,
    status: r.state,
    created_at: isoFromMs(Number(r.created_at_ms)),
    completed_at: r.completed_at_ms === null ? null : isoFromMs(Number(r.completed_at_ms)),
    cached,
    model: r.model,
    inference: "NEAR AI Cloud private inference (TEE)",
    asset: JSON.parse(r.asset_json) as AppraisalAsset,
    result: r.result_json ? (JSON.parse(r.result_json) as AppraisalResult) : null,
    rubric: { version: r.rubric_version, hash: r.rubric_hash },
    input_hash: r.input_hash,
    evidence: {
      chat_id: r.chat_id,
      request_hash: r.request_hash,
      response_hash: r.response_hash,
      signed_text: r.signed_text,
      signature: r.signature,
      signing_address: r.signing_address,
      signing_algo: r.signing_algo,
      signature_kind: r.signature_kind,
      request_body: r.request_body,
      response_body: r.response_body,
    },
    attestation,
    verified: {
      signature: r.signature_ok === 1n,
      signature_reasons: r.signature_reasons ? (JSON.parse(r.signature_reasons) as string[]) : [],
      attestation: (r.attestation_verdict ?? "not_checked") as "checked" | "not_checked" | "failed",
    },
    usage,
    cost_usd_estimate: r.cost_usd,
    notes: NOTES,
  };
}

/** The short form shown next to a listing (`appraisal=<id>` in its `detail`); `null` when the id is unknown or not done. */
export function appraisalBrief(db: Database.Database, id: string) {
  if (!APPRAISAL_ID.test(id)) return null;
  const r = row<AppraisalRow>(db, "SELECT * FROM appraisals WHERE appraisal_id = ? AND state = 'done'", id);
  if (!r || !r.result_json) return null;
  const result = JSON.parse(r.result_json) as AppraisalResult;
  return {
    appraisal_id: r.appraisal_id,
    model: r.model,
    value_credits: result.value_credits,
    range: result.range,
    confidence: result.confidence,
    flags: result.flags,
    verified: { signature: r.signature_ok === 1n, attestation: (r.attestation_verdict ?? "not_checked") as "checked" | "not_checked" | "failed" },
    rubric_hash: r.rubric_hash,
    url: `/x207/appraisals/${r.appraisal_id}`,
  };
}

/** `appraisal=apr_<24 hex>` anywhere in the free `detail` of a listing (the off-chain metadata of an offer). */
export const APPRAISAL_IN_DETAIL = /(?:^|[\s|;,{"])appraisal(?:_id)?["]?\s*[=:]\s*"?(apr_[0-9a-f]{24})\b/;
export function appraisalOfDetail(db: Database.Database, detail: string): ReturnType<typeof appraisalBrief> {
  const m = APPRAISAL_IN_DETAIL.exec(detail);
  return m ? appraisalBrief(db, m[1]!) : null;
}

function cloudFailure(err: unknown): ApiError {
  if (err instanceof CloudError) {
    if (err.kind === "credits") return new ApiError(503, "appraiser_credits_exhausted", "The NEAR AI Cloud credits of the x207 appraiser are used up; nothing was appraised. Try again after the operator tops up the account at cloud.near.ai.", {});
    if (err.kind === "auth") return new ApiError(503, "appraiser_unavailable", "The appraiser is misconfigured (NEAR AI Cloud refused its key); nothing was appraised", {});
    return new ApiError(502, "appraiser_unavailable", `${err.message}; nothing was appraised`, { reason: err.kind });
  }
  return new ApiError(502, "appraiser_unavailable", "The appraiser failed; nothing was appraised", {});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function appraiserRoutes(db: Database.Database, config: AppraiserConfig): Route[] {
  migrate(db, MARKETPLACE_MIGRATIONS);
  const count = (sql: string, ...args: unknown[]) => Number(row<{ n: bigint }>(db, sql, ...args)?.n ?? 0n);
  const oldest = (sql: string, ...args: unknown[]) => row<{ t: bigint | null }>(db, sql, ...args)?.t ?? null;

  return [
    {
      method: "GET",
      pattern: "/x207/appraisals/{appraisal}",
      circleScoped: false,
      handler: ({ params }) => {
        const id = params.appraisal ?? "";
        if (!APPRAISAL_ID.test(id)) throw invalidRequest("appraisal id must be apr_ followed by 24 lowercase hex characters", { appraisal: id });
        const r = row<AppraisalRow>(db, "SELECT * FROM appraisals WHERE appraisal_id = ?", id);
        if (!r) throw new ApiError(404, "appraisal_not_found", `Appraisal ${id} not found`, { appraisal: id });
        return { status: 200, body: view(r, false) };
      },
    },
    {
      method: "POST",
      pattern: "/x207/appraise",
      circleScoped: false,
      allowInReadOnly: true,
      handler: async ({ body, ip, now }) => {
        const asset = assetOf(body);
        const cloud = config.cloud;
        if (!cloud) throw new ApiError(503, "appraiser_disabled", "The appraiser is not configured on this server (no NEAR AI Cloud key)", {});
        const model = config.model;
        const inputHash = sha256Hex([canonicalAsset(asset), RUBRIC_HASH, model].join("\n"));
        const id = `apr_${inputHash.slice(0, 24)}`;
        const address = ip ?? "unknown";
        const t = now();

        // one synchronous step: cache, limits and the reservation, so that parallel requests are counted
        const existing = row<AppraisalRow>(db, "SELECT * FROM appraisals WHERE appraisal_id = ?", id);
        if (existing?.state === "done") return { status: 200, body: view(existing, true) };
        if (existing && Number(existing.created_at_ms) > t - STALE_PENDING_MS) throw new ApiError(409, "appraisal_in_progress", "The same asset is being appraised; ask again in a moment", { appraisal_id: id });
        if (existing) db.prepare("DELETE FROM appraisals WHERE appraisal_id = ?").run(id);
        if (count("SELECT COUNT(*) AS n FROM appraisals WHERE ip = ? AND created_at_ms > ?", address, t - DAY_MS) >= config.perIpPerDay) {
          const first = Number(oldest("SELECT MIN(created_at_ms) AS t FROM appraisals WHERE ip = ? AND created_at_ms > ?", address, t - DAY_MS) ?? BigInt(t));
          throw rateLimited("This address has asked for too many appraisals today", { scope: "appraiser_ip", limitPerDay: config.perIpPerDay }, Math.max(1, Math.ceil((first + DAY_MS - t) / 1000)));
        }
        if (count("SELECT COUNT(*) AS n FROM appraisals WHERE created_at_ms > ?", t - DAY_MS) >= config.perDay) {
          const first = Number(oldest("SELECT MIN(created_at_ms) AS t FROM appraisals WHERE created_at_ms > ?", t - DAY_MS) ?? BigInt(t));
          throw rateLimited("The appraiser has reached its daily quota", { scope: "appraiser_day", limitPerDay: config.perDay }, Math.max(1, Math.ceil((first + DAY_MS - t) / 1000)));
        }
        db.prepare("INSERT INTO appraisals (appraisal_id, input_hash, ip, state, asset_json, model, rubric_version, rubric_hash, created_at_ms) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)")
          .run(id, inputHash, address, canonicalAsset(asset), model, RUBRIC_VERSION, RUBRIC_HASH, t);
        const release = () => db.prepare("DELETE FROM appraisals WHERE appraisal_id = ? AND state = 'pending'").run(id);

        try {
          const requestBody = chatRequestBody(asset, model, config.maxTokens);
          let responseBody: string;
          try {
            responseBody = await cloud.chat(requestBody);
          } catch (err) {
            throw cloudFailure(err);
          }
          const parsed = parseJson(responseBody) as { id?: unknown; choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null;
          const chatId = typeof parsed?.id === "string" ? parsed.id : null;
          const content = parsed?.choices?.[0]?.message?.content;
          if (!chatId || typeof content !== "string") throw new ApiError(502, "appraiser_bad_output", "NEAR AI Cloud answered without a chat id or a message", {});
          let result: AppraisalResult;
          try {
            result = parseAppraisal(content);
          } catch (err) {
            throw new ApiError(502, "appraiser_bad_output", `The model did not keep the output contract: ${err instanceof Error ? err.message : "unknown"}`, { chat_id: chatId });
          }

          // the signature can lag the answer for a moment
          let signature: Awaited<ReturnType<NearAiCloud["signature"]>> | null = null;
          for (let attempt = 0; attempt < 3 && signature === null; attempt++) {
            try {
              signature = await cloud.signature(chatId, model);
            } catch (err) {
              if (err instanceof CloudError && err.kind === "credits") throw cloudFailure(err);
              if (attempt < 2) await sleep(config.signatureRetryMs ?? 1000);
            }
          }
          const requestHash = sha256Hex(requestBody);
          const responseHash = sha256Hex(responseBody);
          const sigCheck = signature
            ? checkSignature({ model, requestHash, responseHash, text: signature.text, signature: signature.signature, signingAddress: signature.signing_address })
            : { ok: false, reasons: ["NEAR AI Cloud returned no signature for this chat"], recovered_address: null };

          let attestation: AttestationSummary | null = null;
          if (signature) {
            try {
              attestation = await attest(model, signature.signing_address, {
                cloud,
                quoteCheck: config.quoteCheck,
                now,
                ...(config.fetch ? { fetch: config.fetch } : {}),
                ...(config.phalaUrl ? { phalaUrl: config.phalaUrl } : {}),
                ...(config.nrasUrl ? { nrasUrl: config.nrasUrl } : {}),
              });
            } catch (err) {
              if (err instanceof CloudError && err.kind === "credits") throw cloudFailure(err);
            }
          }
          const verdict = attestation ? attestationVerdict(attestation) : "not_checked";
          const prompt = typeof parsed?.usage?.prompt_tokens === "number" ? parsed.usage.prompt_tokens : 0;
          const completion = typeof parsed?.usage?.completion_tokens === "number" ? parsed.usage.completion_tokens : 0;
          const price = APPRAISER_MODELS[model] ?? { in: 0, out: 0 };
          const cost = ((prompt * price.in + completion * price.out) / 1e6).toFixed(8);

          db.prepare(
            `UPDATE appraisals SET state = 'done', request_body = ?, response_body = ?, request_hash = ?, response_hash = ?, chat_id = ?, result_json = ?,
               signed_text = ?, signature = ?, signing_address = ?, signing_algo = ?, signature_kind = ?, signature_ok = ?, signature_reasons = ?,
               attestation_json = ?, attestation_verdict = ?, usage_json = ?, cost_usd = ?, completed_at_ms = ? WHERE appraisal_id = ?`,
          ).run(
            requestBody, responseBody, requestHash, responseHash, chatId, JSON.stringify(result),
            signature?.text ?? null, signature?.signature ?? null, signature?.signing_address.toLowerCase() ?? null, signature?.signing_algo ?? null, signature?.signature_kind ?? null,
            sigCheck.ok ? 1 : 0, JSON.stringify(sigCheck.reasons),
            attestation ? JSON.stringify(attestation) : null, verdict, JSON.stringify({ prompt_tokens: prompt, completion_tokens: completion }), cost, now(), id,
          );
        } catch (err) {
          release();
          throw err instanceof ApiError ? err : cloudFailure(err);
        }
        const done = row<AppraisalRow>(db, "SELECT * FROM appraisals WHERE appraisal_id = ?", id);
        return { status: 201, body: view(done!, false) };
      },
    },
  ];
}
