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
  /** Batas penyalahgunaan (BE-066): rate tulis per IP dan per akun, ukuran body, ukuran halaman. Tanpa ini: hanya ukuran body 64 KiB dan halaman 200. */
  abuse?: Partial<AbuseLimits>;
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

/** Body JSON sebuah `POST`: objek apa pun yang muat di `maxBytes`; lebih besar dari itu 413 `payload_too_large`, bukan JSON 400 `invalid_request`. */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const tooLarge = () => new ApiError(413, "payload_too_large", "Body terlalu besar", { maxBytes }, { Connection: "close" });
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
    throw invalidRequest("body bukan JSON yang sah");
  }
}

const REQUIRED_TABLES = ["circles", "indexer_cursor", "members", "epochs"];

/** Variabel `.env`: `API_RATE_LIMIT_PER_MINUTE` (bilangan bulat ≥ 0). */
export function apiOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { rateLimitPerMinute: number; abuse: AbuseLimits } {
  const { limits } = abuseFromEnv(env);
  return { rateLimitPerMinute: limits.ipPerMinute, abuse: limits };
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
  const abuse: AbuseLimits = { ...DEFAULT_LIMITS, ipPerMinute: limit, writeIpPerMinute: 0, writeAccountPerMinute: 0, ...options.abuse };
  const routes: Route[] = [...healthRoutes, ...memberRoutes, ...limitRoutes, ...epochRoutes, ...obligationRoutes, ...settlementRoutes, ...paramRoutes, ...bundleRoutes, ...grantRoutes, ...intentRoutes, ...eventRoutes, ...metricRoutes, ...ruleRoutes, ...reportRoutes, ...workerRoutes(options.settlement), ...(options.daoView ? proposalRoutes(options.daoView) : []), ...(options.extraRoutes ?? [])];
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
      if (wait > 0) throw rateLimited("Terlalu banyak permintaan", { limitPerMinute: abuse.ipPerMinute }, wait);
      ipHits.add(ip, t);
    }
    if (write && abuse.writeIpPerMinute > 0) {
      const wait = writeIpHits.wait(ip, abuse.writeIpPerMinute, t);
      if (wait > 0) throw rateLimited("Terlalu banyak permintaan tulis dari alamat ini", { scope: "ip_write", limitPerMinute: abuse.writeIpPerMinute }, wait);
      writeIpHits.add(ip, t);
    }
  }

  async function handle(req: IncomingMessage): Promise<{ result: RouteResult; indexedBlock?: string }> {
    checkRate(callerOf(req), req.method === "POST");
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
      const asked = url.searchParams.get("limit");
      if (asked !== null && /^\d+$/.test(asked) && Number(asked) > abuse.maxPageLimit) throw invalidRequest(`limit harus 1..${abuse.maxPageLimit}`, { limit: asked, max: abuse.maxPageLimit });
      const body = match.route.method === "POST" ? await readJsonBody(req, abuse.maxBodyBytes) : undefined;
      // a write is counted for its account only when it was accepted: a request that names someone else's account but fails its signature costs that account nothing
      const account = abuse.writeAccountPerMinute > 0 && match.route.method === "POST" ? accountOfBody(body) : null;
      if (account !== null) {
        const wait = accountHits.wait(account, abuse.writeAccountPerMinute, now());
        if (wait > 0) throw rateLimited(`Akun ${account} terlalu sering menulis`, { scope: "account_write", account, limitPerMinute: abuse.writeAccountPerMinute }, wait);
      }
      const result = await match.route.handler({ db, params: match.params, query: url.searchParams, now, circle, body });
      if (account !== null && result.status >= 200 && result.status < 300) accountHits.add(account, now());
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
