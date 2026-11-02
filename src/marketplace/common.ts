export const isoSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Waktu server dalam detik unix, pembanding `expires_at`. */
export const nowSeconds = (nowMs: number): number => Math.floor(nowMs / 1000);
