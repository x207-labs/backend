// Small HTTP helper of the adapters with an API (BE-059). The credential goes in a header built here and nowhere else: the error of a failed call names the method, the path and the
// status, never the headers, and the text of the answer is cut, so a token cannot reach a log through an error.
export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export class ProviderHttpError extends Error {
  constructor(readonly status: number, message: string, /** Seconds the provider asks to wait (429). */ readonly retryAfter: number | null = null) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export interface Call {
  method: "GET" | "PUT" | "POST" | "DELETE";
  path: string;
  body?: string;
  headers?: Record<string, string>;
}

/** The most of an answer that the helper reads (security review batch 8): a provider that is hostile or broken cannot make the broker hold a huge body in memory. */
export const MAX_ANSWER_BYTES = 1_048_576;

/** The secrets in the headers of a request, in every form that a provider may echo: the whole value, the part after the scheme, and for Basic the decoded text and its two halves. */
function secretsOf(headers: Record<string, string>): string[] {
  const found = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!/^(authorization|x-api-key|api-key|cookie|proxy-authorization)$/i.test(name) || value === "") continue;
    found.add(value);
    const m = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(value);
    if (m) {
      found.add(m[2] as string);
      if (/^basic$/i.test(m[1] as string)) {
        const decoded = Buffer.from(m[2] as string, "base64").toString("utf8");
        found.add(decoded);
        for (const part of decoded.split(":")) found.add(part);
        for (const part of decoded.split(":")) found.add(encodeURIComponent(part));
      }
    }
  }
  return [...found].filter((x) => x.length >= 6); // a short value would eat ordinary words of the message
}

const scrub = (text: string, secrets: readonly string[]): string => secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);

/** Reads the answer up to `MAX_ANSWER_BYTES`; a longer one is cut off at the stream and refused. */
async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) throw new ProviderHttpError(response.status, `the answer is larger than ${MAX_ANSWER_BYTES} bytes`);
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderHttpError(response.status, `the answer is larger than ${MAX_ANSWER_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `GET`, `PUT`, … against `baseUrl` + path with the headers of the adapter; the answer is returned for any status in `accept`, otherwise `ProviderHttpError`. The message of that error never holds the credential of the request, even when the provider echoes it. */
export async function call(fetchImpl: FetchLike, baseUrl: string, headers: Record<string, string>, c: Call, accept: readonly number[] = [200, 201, 204]): Promise<{ status: number; text: string }> {
  const sent = { ...headers, ...c.headers };
  const response = await fetchImpl(`${baseUrl}${c.path}`, { method: c.method, headers: sent, ...(c.body === undefined ? {} : { body: c.body }), signal: AbortSignal.timeout(10_000) });
  const text = await readLimited(response);
  if (accept.includes(response.status)) return { status: response.status, text };
  const retry = Number(response.headers.get("retry-after"));
  throw new ProviderHttpError(response.status, `${c.method} ${c.path.split("?")[0]} -> HTTP ${response.status}: ${scrub(text, secretsOf(sent)).replace(/\s+/g, " ").slice(0, 160)}`, Number.isFinite(retry) && retry > 0 ? retry : null);
}
