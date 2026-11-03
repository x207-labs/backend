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

/** `GET`, `PUT`, … against `baseUrl` + path with the headers of the adapter; the answer is returned for any status in `accept`, otherwise `ProviderHttpError`. */
export async function call(fetchImpl: FetchLike, baseUrl: string, headers: Record<string, string>, c: Call, accept: readonly number[] = [200, 201, 204]): Promise<{ status: number; text: string }> {
  const response = await fetchImpl(`${baseUrl}${c.path}`, { method: c.method, headers: { ...headers, ...c.headers }, ...(c.body === undefined ? {} : { body: c.body }), signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  if (accept.includes(response.status)) return { status: response.status, text };
  const retry = Number(response.headers.get("retry-after"));
  throw new ProviderHttpError(response.status, `${c.method} ${c.path.split("?")[0]} -> HTTP ${response.status}: ${text.replace(/\s+/g, " ").slice(0, 160)}`, Number.isFinite(retry) && retry > 0 ? retry : null);
}
