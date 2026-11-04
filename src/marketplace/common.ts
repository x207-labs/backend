export const isoSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Server time in unix seconds, for comparing with `expires_at`. */
export const nowSeconds = (nowMs: number): number => Math.floor(nowMs / 1000);
