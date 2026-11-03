// Limits against abuse of the access routes of the broker (BE-066). In memory, per process: two brokers behind one balancer each count for themselves. The same idea as `src/api/abuse.ts`
// of the backend (the broker is a separate package, so the few lines are repeated).
export const WINDOW_MS = 60_000;

export interface AccessLimits {
  /** Requests per minute per address of the peer, 0 = off. Env `BROKER_ACCESS_RATE_PER_MINUTE_IP`. */
  ipPerMinute: number;
  /** Requests per minute per grant, 0 = off. Env `BROKER_ACCESS_RATE_PER_MINUTE_GRANT`. */
  grantPerMinute: number;
  /** Largest body of a POST in bytes, answered 413 above it. Env `BROKER_MAX_BODY_BYTES`. */
  maxBodyBytes: number;
}
export const DEFAULT_ACCESS_LIMITS: AccessLimits = { ipPerMinute: 120, grantPerMinute: 60, maxBodyBytes: 16 * 1024 };

export class WindowCounter {
  readonly #hits = new Map<string, { start: number; count: number }>();
  /** Counts a hit; returns the seconds to wait when the key is over `limit`, else 0. */
  hit(key: string, limit: number, t: number): number {
    if (limit <= 0) return 0;
    let e = this.#hits.get(key);
    if (!e || t - e.start >= WINDOW_MS) {
      if (this.#hits.size > 10_000) for (const [k, v] of this.#hits) if (t - v.start >= WINDOW_MS) this.#hits.delete(k);
      e = { start: t, count: 0 };
      this.#hits.set(key, e);
    }
    e.count += 1;
    return e.count > limit ? Math.max(1, Math.ceil((e.start + WINDOW_MS - t) / 1000)) : 0;
  }
}

/** The body of a request as text, or `null` when it is larger than `max` (checked on the declared length and again while it is read). */
export async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
