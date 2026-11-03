import { providersFromEnv, type ProviderConfig } from "./proxy/providers.js";

export class ConfigError extends Error {}

export interface BrokerConfig {
  readApiUrl: string;
  circleId: string;
  contractId: string;
  facilitatorUrl: string;
  rpcUrl: string;
  brokerAccount: string;
  brokerKey: string;
  leaseAccount: string;
  leaseKey: string;
  port: number;
  dbPath: string;
  pollSeconds: number;
  /** Class C providers (BK-008); empty = class C off. The secrets are read from the environment variables they name. */
  providers: ProviderConfig[];
  /** `self-hosted` (default): the grantor runs this broker and the administrator tokens of the providers stay on its machine. `hosted`: demo only, mock providers only (BE-057, ADR-47). */
  mode: "self-hosted" | "hosted";
  /** Limits of the access routes (BE-066); env `BROKER_ACCESS_RATE_PER_MINUTE_IP`, `BROKER_ACCESS_RATE_PER_MINUTE_GRANT`, `BROKER_MAX_BODY_BYTES`. */
  accessLimits: { ipPerMinute: number; grantPerMinute: number; maxBodyBytes: number };
  /** JSON lines audit log of the class C calls (BK-011); empty = no file. */
  auditPath: string;
}

/** Reads the variables of `.env.example`. The error names the variable, never its value (keys are secrets). */
export function readConfig(env: Record<string, string | undefined>): BrokerConfig {
  const need = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") throw new ConfigError(`${name} is required (see .env.example)`);
    return value;
  };
  const key = (name: string): string => {
    const value = need(name);
    if (!value.startsWith("ed25519:")) throw new ConfigError(`${name} must have the form ed25519:<base58>`);
    return value;
  };
  const int = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer >= 0`);
    return Number(raw);
  };
  const mode = (): "self-hosted" | "hosted" => {
    const raw = env.BROKER_MODE ?? "";
    if (raw === "" || raw === "self-hosted") return "self-hosted";
    if (raw === "hosted") return "hosted";
    throw new ConfigError("BROKER_MODE must be self-hosted or hosted");
  };
  const limitsRaw = env.BROKER_LIMITS ?? env.API_LIMITS ?? "";
  if (limitsRaw !== "" && limitsRaw !== "on" && limitsRaw !== "off") throw new ConfigError("BROKER_LIMITS (or API_LIMITS) must be off or on");
  const off = limitsRaw === "off";
  return {
    readApiUrl: need("X207_READ_API_URL"),
    circleId: env.X207_CIRCLE_ID || "agents-main",
    contractId: need("X207_CONTRACT_ID"),
    facilitatorUrl: need("X207_FACILITATOR_URL"),
    rpcUrl: need("NEAR_RPC_URL"),
    brokerAccount: need("BROKER_ACCOUNT_ID"),
    brokerKey: key("BROKER_PRIVATE_KEY"),
    leaseAccount: need("BROKER_LEASE_ACCOUNT_ID"),
    leaseKey: key("BROKER_LEASE_PRIVATE_KEY"),
    port: int("BROKER_PORT", 8090),
    dbPath: env.BROKER_DB_PATH || "./broker.db",
    pollSeconds: int("BROKER_POLL_SECONDS", 15),
    providers: providersFromEnv(env),
    auditPath: env.BROKER_AUDIT_PATH ?? "",
    mode: mode(),
    // API_LIMITS=off (the same variable as the backend) or BROKER_LIMITS=off turns the rate limits off; the size of a body stays
    accessLimits: { ipPerMinute: off ? 0 : int("BROKER_ACCESS_RATE_PER_MINUTE_IP", 120), grantPerMinute: off ? 0 : int("BROKER_ACCESS_RATE_PER_MINUTE_GRANT", 60), maxBodyBytes: Math.max(1024, int("BROKER_MAX_BODY_BYTES", 16 * 1024)) },
  };
}
