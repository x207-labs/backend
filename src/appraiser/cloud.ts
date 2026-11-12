// BE-119: the three calls of NEAR AI Cloud that an appraisal needs. The API key is read from the env of the server only
// (`X207_APPRAISER_NEARAI_KEY`, fallback `NEARAI_API_KEY`) and is never put in a response, a log line or the database.
//   POST /v1/chat/completions                                   the bytes sent and the bytes received are kept as they are (their sha256 is what is signed)
//   GET  /v1/signature/{chat_id}?model=&signing_algo=ecdsa      `{text, signature, signing_address, signing_algo}`
//   GET  /v1/attestation/report?model=&signing_algo=ecdsa&nonce= `{gateway_attestation, model_attestations[]}`
// `fetch` is injected, so the tests run on a mock transport.
import type { AttestationReport } from "./verify.js";

export const DEFAULT_CLOUD_URL = "https://cloud-api.near.ai/v1";

export class CloudError extends Error {
  constructor(
    message: string,
    /** `credits` when NEAR AI Cloud says the balance is used up (HTTP 402, or an error that names credits/balance/quota). */
    readonly kind: "credits" | "auth" | "rate" | "upstream" | "timeout" | "bad_response",
    readonly status: number | null,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

export interface SignatureResponse {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

export interface CloudOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const CREDITS = /credit|balance|quota|insufficient|payment/i;

export class NearAiCloud {
  readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  constructor(private readonly opts: CloudOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_CLOUD_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async call(method: "GET" | "POST", path: string, body?: string): Promise<string> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.opts.apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      throw new CloudError(timeout ? "NEAR AI Cloud did not answer in time" : "NEAR AI Cloud could not be reached", timeout ? "timeout" : "upstream", null);
    }
    const text = await res.text();
    if (res.ok) return text;
    // the upstream message is only matched, never passed on: it could echo request headers
    if (res.status === 402 || (res.status !== 401 && CREDITS.test(text))) throw new CloudError("The NEAR AI Cloud credits of this server are used up", "credits", res.status);
    if (res.status === 401 || res.status === 403) throw new CloudError("NEAR AI Cloud refused the API key of this server", "auth", res.status);
    if (res.status === 429) throw new CloudError("NEAR AI Cloud is rate limiting this server", "rate", res.status);
    throw new CloudError(`NEAR AI Cloud answered HTTP ${res.status}`, "upstream", res.status);
  }

  /** The raw response text is returned as received: its sha256 must equal the hash in the signed text. */
  chat(requestBody: string): Promise<string> {
    return this.call("POST", "/chat/completions", requestBody);
  }

  async signature(chatId: string, model: string): Promise<SignatureResponse> {
    const text = await this.call("GET", `/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`);
    const parsed = parseJson(text) as Partial<SignatureResponse> | null;
    if (!parsed || typeof parsed.text !== "string" || typeof parsed.signature !== "string" || typeof parsed.signing_address !== "string") {
      throw new CloudError("NEAR AI Cloud returned no signature for this chat", "bad_response", 200);
    }
    return { text: parsed.text, signature: parsed.signature, signing_address: parsed.signing_address, signing_algo: parsed.signing_algo ?? "ecdsa", ...(parsed.signature_kind ? { signature_kind: parsed.signature_kind } : {}) };
  }

  async attestation(model: string, nonce: string): Promise<AttestationReport> {
    const text = await this.call("GET", `/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`);
    const parsed = parseJson(text) as AttestationReport | null;
    if (!parsed || !Array.isArray(parsed.model_attestations)) throw new CloudError("NEAR AI Cloud returned no attestation report", "bad_response", 200);
    return parsed;
  }
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
