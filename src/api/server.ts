import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { ApiError, invalidRequest } from "./errors.js";
import { row } from "./format.js";
import { matchRoute, type CircleRow, type Route, type RouteResult } from "./router.js";
import { bundleRoutes } from "./routes/bundles.js";
import { eventRoutes } from "./routes/events.js";
import { grantRoutes } from "./routes/grants.js";
import { intentRoutes } from "./routes/intents.js";
import { epochRoutes } from "./routes/epochs.js";
import { healthRoutes } from "./routes/health.js";
import { limitRoutes } from "./routes/limits.js";
import { memberRoutes } from "./routes/members.js";
import { metricRoutes } from "./routes/metrics.js";
import { obligationRoutes } from "./routes/obligations.js";
import { paramRoutes } from "./routes/params.js";
import { reportRoutes } from "../report207/index.js";
import { ruleRoutes } from "./routes/rules.js";
import { settlementRoutes } from "./routes/settlements.js";
import { jobRoutes } from "./routes/jobs.js";
import { proposalRoutes } from "./routes/proposals.js";
import type { ViewFunction } from "../settlement/intents.js";
import { depositQuoteRoutes, type AccountExists } from "../settlement/deposit/quote.js";
import type { OneClickClient } from "../settlement/one-click.js";
import { withdrawRoutes } from "../settlement/withdraw/routes.js";

export interface ApiServerOptions {
  db: Database.Database;
  /** Permintaan per menit per IP; 0 atau kosong = tanpa batas. */
  rateLimitPerMinute?: number;
  now?: () => number;
  /** Route tambahan dari modul lain (laporan 207, settlement, dll.). */
  extraRoutes?: readonly Route[];
  /**
   * Settlement worker (M5): bila diisi, server melayani `POST /x207/settlement/deposit/quote`,
   * `POST /x207/settlement/withdraw/{quote,intent,submit}` dan `GET /x207/settlement/jobs/{jobId}`.
   */
  settlement?: { client: OneClickClient; accountExists: AccountExists };
  /** View NEAR untuk `GET …/proposals` (BE-023); tanpa ini path itu tidak ada. */
  daoView?: ViewFunction;
}

const MAX_BODY_BYTES = 64 * 1024;

/** Body JSON sebuah `POST`: objek apa pun yang muat di 64 KiB; selain itu 400 `invalid_request`. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw invalidRequest("body terlalu besar", { maxBytes: MAX_BODY_BYTES });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalidRequest("body bukan JSON yang sah");
  }
}

const REQUIRED_TABLES = ["circles", "indexer_cursor", "members", "epochs"];
const RATE_WINDOW_MS = 60_000;

/** Variabel `.env`: `API_RATE_LIMIT_PER_MINUTE` (bilangan bulat ≥ 0). */
export function apiOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { rateLimitPerMinute: number } {
  const raw = env.API_RATE_LIMIT_PER_MINUTE;
  if (raw === undefined || raw === "") return { rateLimitPerMinute: 0 };
  if (!/^\d+$/.test(raw)) throw new Error(`API_RATE_LIMIT_PER_MINUTE must be a non-negative integer, got "${raw}"`);
  return { rateLimitPerMinute: Number(raw) };
}

function d9Ready(db: Database.Database): boolean {
  const have = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
  );
  return REQUIRED_TABLES.every((t) => have.has(t));
}

function send(res: ServerResponse, result: RouteResult, extra: Record<string, string>): void {
  const payload = JSON.stringify(result.body);
  res.writeHead(result.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extra,
    ...result.headers,
  });
  res.end(payload);
}

function workerRoutes(settlement: ApiServerOptions["settlement"]): Route[] {
  if (!settlement) return [];
  return [...depositQuoteRoutes(settlement), ...withdrawRoutes(settlement), ...jobRoutes(settlement.client)];
}

/** Server read API (Spec API Backend). Pemanggil yang memanggil `listen`. */
export function createApiServer(options: ApiServerOptions): Server {
  const { db } = options;
  const now = options.now ?? Date.now;
  const limit = options.rateLimitPerMinute ?? 0;
  const routes: Route[] = [...healthRoutes, ...memberRoutes, ...limitRoutes, ...epochRoutes, ...obligationRoutes, ...settlementRoutes, ...paramRoutes, ...bundleRoutes, ...grantRoutes, ...intentRoutes, ...eventRoutes, ...metricRoutes, ...ruleRoutes, ...reportRoutes, ...workerRoutes(options.settlement), ...(options.daoView ? proposalRoutes(options.daoView) : []), ...(options.extraRoutes ?? [])];
  const hits = new Map<string, { windowStart: number; count: number }>();

  function checkRate(ip: string): void {
    if (limit <= 0) return;
    const t = now();
    let entry = hits.get(ip);
    if (!entry || t - entry.windowStart >= RATE_WINDOW_MS) {
      entry = { windowStart: t, count: 0 };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.windowStart + RATE_WINDOW_MS - t) / 1000));
      throw new ApiError(429, "rate_limited", "Terlalu banyak permintaan", { limitPerMinute: limit }, {
        "Retry-After": String(retryAfter),
      });
    }
  }

  async function handle(req: IncomingMessage): Promise<{ result: RouteResult; indexedBlock?: string }> {
    checkRate(req.socket.remoteAddress ?? "unknown");
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = matchRoute(routes, req.method ?? "GET", url.pathname);
    if (!match) throw new ApiError(404, "not_found", "Endpoint tidak dikenal", { path: url.pathname });

    let circle: CircleRow = { circle_id: "", contract_id: "", network: "" };
    let indexedBlock: string | undefined;
    if (match.route.circleScoped) {
      if (!d9Ready(db)) throw new ApiError(503, "indexer_unavailable", "Basis data D9 belum siap");
      const found = row<CircleRow>(db, "SELECT circle_id, contract_id, network FROM circles WHERE circle_id = ?", match.params.circle);
      if (!found) throw new ApiError(404, "circle_not_found", `Lingkaran ${match.params.circle} tidak ada`, { circle: match.params.circle });
      circle = found;
      const cursor = row<{ last_block_height: bigint }>(
        db,
        "SELECT last_block_height FROM indexer_cursor WHERE contract_id = ?",
        circle.contract_id,
      );
      if (!cursor) throw new ApiError(503, "indexer_unavailable", "Indexer belum bootstrap", { circle: circle.circle_id });
      indexedBlock = cursor.last_block_height.toString();
    }
    try {
      const body = match.route.method === "POST" ? await readJsonBody(req) : undefined;
      const result = await match.route.handler({ db, params: match.params, query: url.searchParams, now, circle, body });
      return indexedBlock === undefined ? { result } : { result, indexedBlock };
    } catch (err) {
      if (err instanceof ApiError && indexedBlock !== undefined) err.headers["X-X207-Indexed-Block"] = indexedBlock;
      throw err;
    }
  }

  return createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
      });
      res.end();
      return;
    }
    try {
      const { result, indexedBlock } = await handle(req);
      send(res, result, indexedBlock === undefined ? {} : { "X-X207-Indexed-Block": indexedBlock });
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, { status: err.status, body: err.toBody(), headers: err.headers }, {});
        return;
      }
      send(res, { status: 500, body: { error: { code: "internal_error", message: "Kesalahan internal", details: {} } } }, {});
    }
  });
}
