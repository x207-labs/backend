import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { ApiError } from "./errors.js";
import { row } from "./format.js";
import { matchRoute, type CircleRow, type Route, type RouteResult } from "./router.js";
import { epochRoutes } from "./routes/epochs.js";
import { healthRoutes } from "./routes/health.js";
import { limitRoutes } from "./routes/limits.js";
import { memberRoutes } from "./routes/members.js";
import { metricRoutes } from "./routes/metrics.js";
import { obligationRoutes } from "./routes/obligations.js";
import { paramRoutes } from "./routes/params.js";
import { settlementRoutes } from "./routes/settlements.js";

export interface ApiServerOptions {
  db: Database.Database;
  /** Permintaan per menit per IP; 0 atau kosong = tanpa batas. */
  rateLimitPerMinute?: number;
  now?: () => number;
  /** Route tambahan dari modul lain (laporan 207, settlement, dll.). */
  extraRoutes?: readonly Route[];
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

/** Server read API (Spec API Backend). Pemanggil yang memanggil `listen`. */
export function createApiServer(options: ApiServerOptions): Server {
  const { db } = options;
  const now = options.now ?? Date.now;
  const limit = options.rateLimitPerMinute ?? 0;
  const routes: Route[] = [...healthRoutes, ...memberRoutes, ...limitRoutes, ...epochRoutes, ...obligationRoutes, ...settlementRoutes, ...paramRoutes, ...metricRoutes, ...(options.extraRoutes ?? [])];
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
      const result = await match.route.handler({ db, params: match.params, query: url.searchParams, now, circle });
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
        "Access-Control-Allow-Methods": "GET, OPTIONS",
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
