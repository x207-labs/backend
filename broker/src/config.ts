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
}

/** Reads the variables of `.env.example`. The error names the variable, never its value (keys are secrets). */
export function readConfig(env: Record<string, string | undefined>): BrokerConfig {
  const need = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") throw new ConfigError(`${name} wajib diisi (lihat .env.example)`);
    return value;
  };
  const key = (name: string): string => {
    const value = need(name);
    if (!value.startsWith("ed25519:")) throw new ConfigError(`${name} harus berbentuk ed25519:<base58>`);
    return value;
  };
  const int = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} harus bilangan bulat >= 0`);
    return Number(raw);
  };
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
  };
}
