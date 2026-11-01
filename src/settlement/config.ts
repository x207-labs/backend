import type { AppFee } from "@defuse-protocol/one-click-sdk-typescript";

/** `mock`: tanpa jaringan (FX-1C). `dry`: 1Click nyata, selalu `dry: true`. `live`: `dry: false` diizinkan. */
export type SettlementMode = "mock" | "dry" | "live";

export interface SettlementConfig {
  mode: SettlementMode;
  baseUrl: string;
  jwt: string | undefined;
  appFees: AppFee[];
}

export const DEFAULT_ONECLICK_BASE_URL = "https://1click.chaindefuser.com";

const MODES: readonly SettlementMode[] = ["mock", "dry", "live"];

/**
 * Variabel `.env`: `X207_SETTLEMENT_MODE` (default `dry`), `ONECLICK_BASE_URL`, `ONECLICK_JWT`,
 * `X207_APP_FEES` (JSON `[{"recipient":"<akun Intents>","fee":<bps>}]`; kosong = tanpa app fee).
 */
export function settlementConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SettlementConfig {
  const rawMode = env.X207_SETTLEMENT_MODE || "dry";
  if (!(MODES as readonly string[]).includes(rawMode)) {
    throw new Error(`X207_SETTLEMENT_MODE must be one of ${MODES.join(", ")}, got "${rawMode}"`);
  }
  return {
    mode: rawMode as SettlementMode,
    baseUrl: env.ONECLICK_BASE_URL || DEFAULT_ONECLICK_BASE_URL,
    jwt: env.ONECLICK_JWT || undefined,
    appFees: parseAppFees(env.X207_APP_FEES),
  };
}

export function parseAppFees(raw: string | undefined): AppFee[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("X207_APP_FEES must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("X207_APP_FEES must be a JSON array");
  return parsed.map((entry: unknown) => {
    const e = entry as { recipient?: unknown; fee?: unknown };
    if (typeof e?.recipient !== "string" || e.recipient === "" || !Number.isInteger(e.fee) || (e.fee as number) <= 0) {
      throw new Error('X207_APP_FEES entries need {"recipient": string, "fee": positive integer bps}');
    }
    return { recipient: e.recipient, fee: e.fee as number };
  });
}
