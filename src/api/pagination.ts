import { invalidRequest } from "./errors.js";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function parseLimit(query: URLSearchParams): number {
  const raw = query.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw invalidRequest("limit must be an integer", { limit: raw });
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) {
    throw invalidRequest(`limit must be 1..${MAX_LIMIT}`, { limit: raw, max: MAX_LIMIT });
  }
  return limit;
}

/** Cursor opak: base64url dari objek JSON kecil, mis. `{"a":"scraper.near"}`. */
export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(query: URLSearchParams): Record<string, unknown> | null {
  const raw = query.get("cursor");
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // jatuh ke error di bawah
  }
  throw invalidRequest("invalid cursor", { cursor: raw });
}
