import type { Server } from "node:http";
import type Database from "better-sqlite3";
import type { ContractAbi } from "@x207/core";
import { apiOptionsFromEnv, createApiServer } from "./api/server.js";
import { openDatabase } from "./db/index.js";
import { daoRegistryFromFile } from "./marketplace/dao-registry.js";
import { MockCodeIssuer } from "./marketplace/code-issuers.js";
import { marketplaceRoutes } from "./marketplace/index.js";
import { FailoverRpcClient } from "./indexer/rpc-client.js";
import { Indexer } from "./indexer/indexer.js";
import { RpcBlockSource, rpcChainReader } from "./indexer/rpc-source.js";
import { settlementConfigFromEnv } from "./settlement/config.js";
import { nearAccountExists } from "./settlement/deposit/quote.js";
import { startJobMonitor } from "./settlement/deposit/monitor.js";
import { abuseFromEnv } from "./api/abuse.js";
import { createLogger } from "./log.js";
import { jsonRpcClaimRpc } from "./marketplace/order-claims.js";
import { rpcViewFunction } from "./settlement/intents.js";
import { OneClickClient } from "./settlement/one-click.js";
import { viewClearedEdges } from "./indexer/view-edges.js";

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
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback?: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) throw new Error(`${name} is required`);
    return fallback;
  }
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer >= 0, got "${raw}"`);
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
  if (!body.result) throw new Error(`get_params failed: ${JSON.stringify(body.error)}`);
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
  // BE-071: one JSON object per line, secrets taken out (src/log.ts); `log` is where the lines go
  const logger = createLogger({ write: log });
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
    fetchClearedEdges: (epoch) => viewClearedEdges(primary, config.contractId, epoch),
  });
  await indexer.bootstrap();

  const client = new OneClickClient({ config: settlement });
  // B7-C10: the shipped binary has no real issuer adapter. A listing with `verifiable: true` is refused `code_issuer_unknown` unless the operator registers one. For a demo only,
  // `X207_CODE_MOCK_ISSUER=<name>` registers the in-memory mock under that name (with the codes of `X207_CODE_MOCK_CODES`, comma separated); it checks nothing at a real issuer.
  const mockIssuer = env.X207_CODE_MOCK_ISSUER ? new MockCodeIssuer() : undefined;
  for (const code of (env.X207_CODE_MOCK_CODES ?? "").split(",").map((c) => c.trim()).filter((c) => c !== "")) mockIssuer?.issue(code);
  if (mockIssuer) logger.warn("X207_CODE_MOCK_ISSUER is set: codes are checked against a mock in memory, not a real issuer (demo only)");
  else logger.warn("no code issuer is registered: a listing with verifiable true is refused code_issuer_unknown; codes can only be sold with verifiable false, up to 20 credit, with no check before the key");
  if (!env.X207_CODE_SEEN_KEY) logger.warn("X207_CODE_SEEN_KEY is empty, codes sold twice are not detected (code_duplicate disabled)");
  const server = createApiServer({ db, ...apiOptionsFromEnv(env), logger, ...(env.METRICS_TOKEN ? { metricsToken: env.METRICS_TOKEN } : {}), rpcProbe: async () => { await viewGetParams(primary, config.contractId); return { endpoint: primary }; }, settlement: { client, accountExists: nearAccountExists(primary) }, daoView: rpcViewFunction(primary), extraRoutes: marketplaceRoutes(db, { chainView: rpcViewFunction(primary), claimRpc: jsonRpcClaimRpc(primary), openLimits: abuseFromEnv(env).open, ...(env.X207_CODE_SEEN_KEY ? { codeSeenKey: env.X207_CODE_SEEN_KEY } : {}), ...(mockIssuer ? { codeIssuers: { [env.X207_CODE_MOCK_ISSUER as string]: mockIssuer } } : {}), daoRegistry: env.X207_DAO_REGISTRY_PATH ? daoRegistryFromFile(env.X207_DAO_REGISTRY_PATH) : [] }) });
  await new Promise<void>((ready) => server.listen(config.port, config.host, ready));
  const stopMonitor = startJobMonitor({ db, client }, config.jobPollMs);

  const abort = new AbortController();
  const running = indexer
    .run({ signal: abort.signal, onError: (error) => logger.warn("indexer: source failed, retrying", { error }) })
    .catch((error: unknown) => logger.error("indexer berhenti", { error }));
  logger.info("x207 backend ready", { host: config.host, port: config.port, contract: config.contractId, mode: settlement.mode });

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
  // a start that cannot go on (a file from a newer build, a missing variable) ends with one JSON line and a code that is not 0, not with a stack
  const app = await startApp().catch((error: unknown) => {
    createLogger({}).error("backend failed to start", { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
    process.exit(1);
  });
  const shutdown = () => void app.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
