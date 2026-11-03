import type { Server } from "node:http";
import type Database from "better-sqlite3";
import type { ContractAbi } from "@x207/core";
import { apiOptionsFromEnv, createApiServer } from "./api/server.js";
import { openDatabase } from "./db/index.js";
import { daoRegistryFromFile } from "./marketplace/dao-registry.js";
import { marketplaceRoutes } from "./marketplace/index.js";
import { FailoverRpcClient } from "./indexer/rpc-client.js";
import { Indexer } from "./indexer/indexer.js";
import { RpcBlockSource, rpcChainReader } from "./indexer/rpc-source.js";
import { settlementConfigFromEnv } from "./settlement/config.js";
import { nearAccountExists } from "./settlement/deposit/quote.js";
import { startJobMonitor } from "./settlement/deposit/monitor.js";
import { jsonRpcClaimRpc } from "./marketplace/order-claims.js";
import { rpcViewFunction } from "./settlement/intents.js";
import { OneClickClient } from "./settlement/one-click.js";

/** Variabel `.env` proses utama; nama RPC dan settlement ada di `.env.example`. */
export interface AppConfig {
  dbPath: string;
  contractId: string;
  circleId: string;
  startBlock: number;
  rpcEndpoints: string[];
  host: string;
  port: number;
  jobPollMs: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`${name} wajib diisi`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`${name} wajib diisi`);
    return fallback;
  }
  if (!/^\d+$/.test(raw)) throw new Error(`${name} harus bilangan bulat >= 0, dapat "${raw}"`);
  return Number(raw);
}

/**
 * `X207_CONTRACT_ID`, `X207_START_BLOCK` (blok deploy), `NEAR_RPC_PRIMARY_URL` wajib; `NEAR_RPC_FALLBACK_URL`,
 * `X207_CIRCLE_ID` (default `agents-main`), `X207_DB_PATH` (default `x207.sqlite`), `X207_API_HOST`
 * (default `127.0.0.1`), `X207_API_PORT` (default 8080), `X207_JOB_POLL_MS` (default 15000) opsional.
 */
export function appConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rpcEndpoints = [required(env, "NEAR_RPC_PRIMARY_URL"), env.NEAR_RPC_FALLBACK_URL ?? ""].filter((u) => u !== "");
  return {
    dbPath: env.X207_DB_PATH || "x207.sqlite",
    contractId: required(env, "X207_CONTRACT_ID"),
    circleId: env.X207_CIRCLE_ID || "agents-main",
    startBlock: integer(env, "X207_START_BLOCK"),
    rpcEndpoints,
    host: env.X207_API_HOST || "127.0.0.1",
    port: integer(env, "X207_API_PORT", 8080),
    jobPollMs: integer(env, "X207_JOB_POLL_MS", 15_000),
  };
}

async function viewGetParams(rpcUrl: string, contractId: string): Promise<ContractAbi.Params> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "x207", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: "get_params", args_base64: Buffer.from("{}").toString("base64") },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as { result?: { result: number[] }; error?: unknown };
  if (!body.result) throw new Error(`get_params gagal: ${JSON.stringify(body.error)}`);
  return JSON.parse(Buffer.from(body.result.result).toString("utf8")) as ContractAbi.Params;
}

export interface App {
  db: Database.Database;
  server: Server;
  indexer: Indexer;
  /** Hentikan indexer, pemantau job dan server, lalu tutup database. */
  stop(): Promise<void>;
}

/**
 * Proses utama: indexer RPC, read API, endpoint settlement (deposit, withdraw, job) dan pemantau job.
 * Worker tidak memegang kunci; mode 1Click dari `X207_SETTLEMENT_MODE` (default `dry`).
 */
export async function startApp(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = console.error): Promise<App> {
  const config = appConfigFromEnv(env);
  const settlement = settlementConfigFromEnv(env);
  const db = openDatabase(config.dbPath);
  const rpc = new FailoverRpcClient({ endpoints: config.rpcEndpoints, timeoutMs: 30_000 });
  const primary = config.rpcEndpoints[0] as string;
  const indexer = new Indexer({
    db,
    source: new RpcBlockSource(rpcChainReader(rpc), config.contractId, config.startBlock),
    circleId: config.circleId,
    contractId: config.contractId,
    startBlock: config.startBlock,
    fetchParams: () => viewGetParams(primary, config.contractId),
  });
  await indexer.bootstrap();

  const client = new OneClickClient({ config: settlement });
  if (!env.X207_CODE_SEEN_KEY) log("peringatan: X207_CODE_SEEN_KEY kosong, kode yang dijual dua kali tidak dideteksi (code_duplicate mati)");
  const server = createApiServer({ db, ...apiOptionsFromEnv(env), settlement: { client, accountExists: nearAccountExists(primary) }, daoView: rpcViewFunction(primary), extraRoutes: marketplaceRoutes(db, { chainView: rpcViewFunction(primary), claimRpc: jsonRpcClaimRpc(primary), ...(env.X207_CODE_SEEN_KEY ? { codeSeenKey: env.X207_CODE_SEEN_KEY } : {}), daoRegistry: env.X207_DAO_REGISTRY_PATH ? daoRegistryFromFile(env.X207_DAO_REGISTRY_PATH) : [] }) });
  await new Promise<void>((ready) => server.listen(config.port, config.host, ready));
  const stopMonitor = startJobMonitor({ db, client }, config.jobPollMs);

  const abort = new AbortController();
  const running = indexer
    .run({ signal: abort.signal, onError: (error) => log(`indexer: ${String(error)}`) })
    .catch((error: unknown) => log(`indexer berhenti: ${String(error)}`));
  log(`x207 backend: ${config.host}:${config.port}, kontrak ${config.contractId}, mode ${settlement.mode}`);

  return {
    db,
    server,
    indexer,
    async stop() {
      stopMonitor();
      abort.abort();
      await running;
      await new Promise<void>((done) => server.close(() => done()));
      db.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await startApp();
  const shutdown = () => void app.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
