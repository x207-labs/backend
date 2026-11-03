// Health and metrics (BE-071). `Telemetry` counts the requests of one process by route, method and status, and the 429 by the scope that refused; `renderMetrics` writes them with the lag of the
// indexer, in the text format of Prometheus. The label `route` is the PATTERN of the route (`/x207/circles/{circle}/orders/{hash}`), never the path of the request, so the number of series does
// not grow with the hashes and accounts that callers send; a path that matches no route is `unmatched`. Counters are in memory: a restart starts them at zero, as Prometheus expects.
import type Database from "better-sqlite3";

const escapeLabel = (v: string): string => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const labels = (l: Record<string, string>): string => `{${Object.entries(l).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;

export class Telemetry {
  readonly #requests = new Map<string, { method: string; route: string; code: string; n: number; seconds: number }>();
  readonly #limited = new Map<string, number>();
  readonly startedAtMs: number;

  constructor(startedAtMs: number = Date.now()) {
    this.startedAtMs = startedAtMs;
  }

  observe(method: string, route: string, status: number, seconds: number): void {
    const key = `${method}\u0000${route}\u0000${status}`;
    const e = this.#requests.get(key) ?? { method, route, code: String(status), n: 0, seconds: 0 };
    e.n += 1;
    e.seconds += seconds;
    this.#requests.set(key, e);
  }

  rateLimited(scope: string): void {
    this.#limited.set(scope, (this.#limited.get(scope) ?? 0) + 1);
  }

  /** Total of the requests with this status (a test and the health check read it). */
  count(status?: number): number {
    let n = 0;
    for (const e of this.#requests.values()) if (status === undefined || e.code === String(status)) n += e.n;
    return n;
  }

  render(): string[] {
    const out: string[] = [];
    out.push("# HELP x207_http_requests_total Requests by method, route pattern and status.", "# TYPE x207_http_requests_total counter");
    for (const e of [...this.#requests.values()].sort((a, b) => (a.route + a.method + a.code).localeCompare(b.route + b.method + b.code))) {
      out.push(`x207_http_requests_total${labels({ method: e.method, route: e.route, code: e.code })} ${e.n}`);
    }
    out.push("# HELP x207_http_request_duration_seconds_sum Time spent in requests, by method, route pattern and status.", "# TYPE x207_http_request_duration_seconds_sum counter");
    for (const e of [...this.#requests.values()].sort((a, b) => (a.route + a.method + a.code).localeCompare(b.route + b.method + b.code))) {
      out.push(`x207_http_request_duration_seconds_sum${labels({ method: e.method, route: e.route, code: e.code })} ${e.seconds.toFixed(6)}`);
    }
    out.push("# HELP x207_rate_limited_total Requests answered 429, by the limit that refused them (ip, ip_write, account_write).", "# TYPE x207_rate_limited_total counter");
    for (const [scope, n] of [...this.#limited.entries()].sort()) out.push(`x207_rate_limited_total${labels({ scope })} ${n}`);
    out.push("# HELP x207_process_start_time_seconds Start of the process.", "# TYPE x207_process_start_time_seconds gauge", `x207_process_start_time_seconds ${(this.startedAtMs / 1000).toFixed(3)}`);
    return out;
  }
}

interface CursorRow {
  name: string;
  last_block_height: bigint;
  head_block_height: bigint;
  lag_blocks: bigint;
  updated_at: bigint;
}

/** The cursors of the indexer, or `null` when the database cannot be read. */
export function readCursors(db: Database.Database): CursorRow[] | null {
  try {
    return db.prepare("SELECT name, last_block_height, head_block_height, lag_blocks, updated_at FROM indexer_cursor ORDER BY name").safeIntegers(true).all() as CursorRow[];
  } catch {
    return null;
  }
}

/** The text of `GET /metrics`: the counters of the process, then the state of the database and of the indexer read now. */
export function renderMetrics(telemetry: Telemetry, db: Database.Database, nowMs: number, extra: string[] = []): string {
  const lines = telemetry.render();
  const cursors = readCursors(db);
  lines.push("# HELP x207_db_up 1 when the database answers.", "# TYPE x207_db_up gauge", `x207_db_up ${cursors === null ? 0 : 1}`);
  lines.push("# HELP x207_indexer_lag_blocks Blocks between the final head and the last block the indexer processed.", "# TYPE x207_indexer_lag_blocks gauge");
  for (const c of cursors ?? []) lines.push(`x207_indexer_lag_blocks${labels({ contract: c.name })} ${c.lag_blocks}`);
  lines.push("# HELP x207_indexer_last_block_height Last block the indexer processed.", "# TYPE x207_indexer_last_block_height gauge");
  for (const c of cursors ?? []) lines.push(`x207_indexer_last_block_height${labels({ contract: c.name })} ${c.last_block_height}`);
  lines.push("# HELP x207_indexer_seconds_since_update Seconds since the cursor of the indexer was written (a stuck indexer grows).", "# TYPE x207_indexer_seconds_since_update gauge");
  for (const c of cursors ?? []) lines.push(`x207_indexer_seconds_since_update${labels({ contract: c.name })} ${Math.max(0, Math.round((nowMs - Number(c.updated_at)) / 1000))}`);
  return `${[...lines, ...extra].join("\n")}\n`;
}
