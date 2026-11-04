import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import { abuseFromEnv, accountOfBody, DEFAULT_LIMITS, rateLimited, WINDOW_MS, WindowCounter, type AbuseLimits } from "./abuse.js";
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
import { opsRoutes } from "./routes/ops.js";
import { Telemetry } from "./telemetry.js";
import { silentLogger, type Logger } from "../log.js";
import { jobRoutes } from "./routes/jobs.js";
import { proposalRoutes } from "./routes/proposals.js";
import type { ViewFunction } from "../settlement/intents.js";
import { depositQuoteRoutes, type AccountExists } from "../settlement/deposit/quote.js";
import type { OneClickClient } from "../settlement/one-click.js";
import { withdrawRoutes } from "../settlement/withdraw/routes.js";

export interface ApiServerOptions {
  db: Database.Database;
  /** Requests per minute per IP; 0 or empty = no limit. */
  rateLimitPerMinute?: number;
  /** Abuse limits (BE-066): write rate per IP and per account, body size, page size. Without this: only a 64 KiB body size and a page size of 200. */
  abuse?: Partial<AbuseLimits>;
  now?: () => number;
  /** Extra routes from other modules (report 207, settlement, etc.). */
  extraRoutes?: readonly Route[];
  /**
   * Settlement worker (M5): when set, the server serves `POST /x207/settlement/deposit/quote`,
   * `POST /x207/settlement/withdraw/{quote,intent,submit}` and `GET /x207/settlement/jobs/{jobId}`.
   */
  settlement?: { client: OneClickClient; accountExists: AccountExists };
  /** Structured JSON log (BE-071); default: does not log. */
  logger?: Logger;
  /** Metrics counter of this process; created internally by default. */
  telemetry?: Telemetry;
  /** Bearer token for `GET /metrics` (env `METRICS_TOKEN`); empty = open. */
  metricsToken?: string;
  /** Cheap query to the RPC for `GET /healthz`; throws if the RPC fails. */
  rpcProbe?: () => Promise<{ endpoint?: string }>;
  /** Extra lines for `GET /metrics`. */
  extraMetrics?: () => string[];
  /** NEAR view for `GET …/proposals` (BE-023); without it that path does not exist. */
  daoView?: ViewFunction;
  /** BE-089: a public read API serves GET only. Every route that is not a GET is left out, so a POST is `404 not_found`; the preflight answers `GET, OPTIONS`. Env `X207_READ_ONLY=1`. */
  readOnly?: boolean;
  /** BE-089: browser origins that may read the API (exact match, e.g. `https://x207-dashboard.vercel.app`). Without it the answer carries `Access-Control-Allow-Origin: *`. Env `X207_CORS_ORIGINS`, comma separated. */
  corsOrigins?: readonly string[];
}

/** The CORS header of an answer: `*` without a list; with a list the origin of the request when it is in it (and `Vary: Origin`), nothing for any other origin. */
export function corsHeaders(allowed: readonly string[] | undefined, origin: string | undefined): Record<string, string> {
  if (allowed === undefined) return { "Access-Control-Allow-Origin": "*" };
  return origin !== undefined && allowed.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : { Vary: "Origin" };
}

/** JSON body of a `POST`: any object that fits in `maxBytes`; larger than that is 413 `payload_too_large`, not JSON 400 `invalid_request`. */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const tooLarge = () => new ApiError(413, "payload_too_large", "Body too large", { maxBytes }, { Connection: "close" });
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw tooLarge();
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalidRequest("body is not valid JSON");
  }
}

const REQUIRED_TABLES = ["circles", "indexer_cursor", "members", "epochs"];

/** `.env` variable: `API_RATE_LIMIT_PER_MINUTE` (integer ≥ 0). */
export function apiOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { rateLimitPerMinute: number; abuse: AbuseLimits; readOnly?: boolean; corsOrigins?: string[] } {
  const { limits } = abuseFromEnv(env);
  const origins = (env.X207_CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");
  for (const o of origins) if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o)) throw new Error(`X207_CORS_ORIGINS: "${o}" is not an origin (scheme://host[:port], no path, no wildcard)`);
  return { rateLimitPerMinute: limits.ipPerMinute, abuse: limits, ...(env.X207_READ_ONLY === "1" ? { readOnly: true } : {}), ...(origins.length > 0 ? { corsOrigins: origins } : {}) };
}

function d9Ready(db: Database.Database): boolean {
  const have = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
  );
  return REQUIRED_TABLES.every((t) => have.has(t));
}

function send(res: ServerResponse, result: RouteResult, extra: Record<string, string>, cors: Record<string, string>): void {
  const payload = result.raw ? result.raw.text : JSON.stringify(result.body);
  res.writeHead(result.status, {
    "Content-Type": result.raw ? result.raw.contentType : "application/json; charset=utf-8",
    ...cors,
    ...extra,
    ...result.headers,
  });
  res.end(payload);
}

function workerRoutes(settlement: ApiServerOptions["settlement"]): Route[] {
  if (!settlement) return [];
  return [...depositQuoteRoutes(settlement), ...withdrawRoutes(settlement), ...jobRoutes(settlement.client)];
}

/** All routes served by this server; also used by the OpenAPI document test (BE-068) so the document and the router do not drift apart. */
export function collectRoutes(options: Pick<ApiServerOptions, "settlement" | "daoView" | "extraRoutes" | "telemetry" | "metricsToken" | "rpcProbe" | "extraMetrics">): Route[] {
  return [...opsRoutes({ telemetry: options.telemetry ?? new Telemetry(), ...(options.metricsToken ? { metricsToken: options.metricsToken } : {}), ...(options.rpcProbe ? { rpcProbe: options.rpcProbe } : {}), ...(options.extraMetrics ? { extraMetrics: options.extraMetrics } : {}) }), ...healthRoutes, ...memberRoutes, ...limitRoutes, ...epochRoutes, ...obligationRoutes, ...settlementRoutes, ...paramRoutes, ...bundleRoutes, ...grantRoutes, ...intentRoutes, ...eventRoutes, ...metricRoutes, ...ruleRoutes, ...reportRoutes, ...workerRoutes(options.settlement), ...(options.daoView ? proposalRoutes(options.daoView) : []), ...(options.extraRoutes ?? [])];
}

/** Read API server (Spec API Backend). The caller is the one that calls `listen`. */
export function createApiServer(options: ApiServerOptions): Server {
  const { db } = options;
  const now = options.now ?? Date.now;
  const limit = options.rateLimitPerMinute ?? 0;
  const abuse: AbuseLimits = { ...DEFAULT_LIMITS, ipPerMinute: limit, writeIpPerMinute: 0, writeAccountPerMinute: 0, ...options.abuse };
  const telemetry = options.telemetry ?? new Telemetry(now());
  const logger = options.logger ?? silentLogger;
  const routes = collectRoutes({ ...options, telemetry }).filter((r) => !options.readOnly || r.method === "GET");
  const ipHits = new WindowCounter();
  const writeIpHits = new WindowCounter();
  const accountHits = new WindowCounter();

  const callerOf = (req: IncomingMessage): string => {
    if (abuse.trustProxy) {
      const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((h) => h.trim()).filter((h) => h !== "");
      if (hops.length > 0) return hops[hops.length - 1] as string;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  function checkRate(ip: string, write: boolean): void {
    const t = now();
    if (abuse.ipPerMinute > 0) {
      const wait = ipHits.wait(ip, abuse.ipPerMinute, t);
      if (wait > 0) throw rateLimited("Too many requests", { limitPerMinute: abuse.ipPerMinute }, wait);
      ipHits.add(ip, t);
    }
    if (write && abuse.writeIpPerMinute > 0) {
      const wait = writeIpHits.wait(ip, abuse.writeIpPerMinute, t);
      if (wait > 0) throw rateLimited("Too many write requests from this address", { scope: "ip_write", limitPerMinute: abuse.writeIpPerMinute }, wait);
      writeIpHits.add(ip, t);
    }
  }

  async function handle(req: IncomingMessage, seen: { route: string }): Promise<{ result: RouteResult; indexedBlock?: string }> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = matchRoute(routes, req.method ?? "GET", url.pathname);
    // the route is known before the limit is checked, so that a request refused with 429 is counted under its route
    if (match) seen.route = match.route.pattern;
    checkRate(callerOf(req), req.method === "POST");
    if (!match) throw new ApiError(404, "not_found", "Unknown endpoint", { path: url.pathname });

    let circle: CircleRow = { circle_id: "", contract_id: "", network: "" };
    let indexedBlock: string | undefined;
    if (match.route.circleScoped) {
      if (!d9Ready(db)) throw new ApiError(503, "indexer_unavailable", "D9 database is not ready");
      const found = row<CircleRow>(db, "SELECT circle_id, contract_id, network FROM circles WHERE circle_id = ?", match.params.circle);
      if (!found) throw new ApiError(404, "circle_not_found", `Circle ${match.params.circle} not found`, { circle: match.params.circle });
      circle = found;
      const cursor = row<{ last_block_height: bigint }>(
        db,
        "SELECT last_block_height FROM indexer_cursor WHERE contract_id = ?",
        circle.contract_id,
      );
      if (!cursor) throw new ApiError(503, "indexer_unavailable", "Indexer has not bootstrapped yet", { circle: circle.circle_id });
      indexedBlock = cursor.last_block_height.toString();
    }
    try {
      const asked = url.searchParams.get("limit");
      if (asked !== null && /^\d+$/.test(asked) && Number(asked) > abuse.maxPageLimit) throw invalidRequest(`limit must be 1..${abuse.maxPageLimit}`, { limit: asked, max: abuse.maxPageLimit });
      const body = match.route.method === "POST" ? await readJsonBody(req, abuse.maxBodyBytes) : undefined;
      // a write is counted for its account only when it was accepted: a request that names someone else's account but fails its signature costs that account nothing
      const account = abuse.writeAccountPerMinute > 0 && match.route.method === "POST" ? accountOfBody(body) : null;
      if (account !== null) {
        const wait = accountHits.wait(account, abuse.writeAccountPerMinute, now());
        if (wait > 0) throw rateLimited(`Account ${account} is writing too often`, { scope: "account_write", account, limitPerMinute: abuse.writeAccountPerMinute }, wait);
      }
      const result = await match.route.handler({ db, params: match.params, query: url.searchParams, now, circle, body, headers: req.headers });
      if (account !== null && result.status >= 200 && result.status < 300) accountHits.add(account, now());
      return indexedBlock === undefined ? { result } : { result, indexedBlock };
    } catch (err) {
      if (err instanceof ApiError && indexedBlock !== undefined) err.headers["X-X207-Indexed-Block"] = indexedBlock;
      throw err;
    }
  }

  return createServer(async (req, res) => {
    const cors = corsHeaders(options.corsOrigins, req.headers.origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": options.readOnly ? "GET, OPTIONS" : "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type",
      });
      res.end();
      return;
    }
    const started = process.hrtime.bigint();
    const seen = { route: "unmatched" };
    let status = 500;
    let failure: unknown;
    try {
      const { result, indexedBlock } = await handle(req, seen);
      status = result.status;
      send(res, result, indexedBlock === undefined ? {} : { "X-X207-Indexed-Block": indexedBlock }, cors);
    } catch (err) {
      if (err instanceof ApiError) {
        status = err.status;
        if (err.code === "rate_limited") telemetry.rateLimited(String(err.details.scope ?? "ip"));
        send(res, { status: err.status, body: err.toBody(), headers: err.headers }, {}, cors);
      } else {
        failure = err;
        send(res, { status: 500, body: { error: { code: "internal_error", message: "Internal error", details: {} } } }, {}, cors);
      }
    } finally {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      telemetry.observe(req.method ?? "GET", seen.route, status, seconds);
      // one line per request: the route PATTERN, never the path, the query or the body (they hold hashes, accounts and signatures)
      if (failure !== undefined) logger.error("internal error", { method: req.method, route: seen.route, status, error: failure });
      else logger.info("request", { method: req.method, route: seen.route, status, ms: Math.round(seconds * 1000), ip: callerOf(req) });
    }
  });
}
