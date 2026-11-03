// `GET /healthz` and `GET /metrics` (BE-071). `/healthz` is for a probe of a load balancer or an operator: the database, the indexer (how many blocks behind, and whether it is still writing its cursor)
// and the RPC (a probe the operator gives, cached ten seconds so that a busy probe does not become a load); 200 for `ok` and `degraded`, 503 for `down`. `/x207/health` (BE-014) stays as it was.
// `/metrics` is the text format of Prometheus; with `METRICS_TOKEN` it needs `Authorization: Bearer <token>`, because the route patterns and the counters tell an outsider what is used.
import { timingSafeEqual } from "node:crypto";
import type { Route } from "../router.js";
import { ApiError } from "../errors.js";
import { DEGRADED_LAG_BLOCKS } from "./health.js";
import { readCursors, renderMetrics, type Telemetry } from "../telemetry.js";

export interface OpsOptions {
  telemetry: Telemetry;
  /** Asks the RPC something cheap; throws when it fails. Without it the RPC is `unknown`. */
  rpcProbe?: () => Promise<{ endpoint?: string }>;
  /** Bearer token for `/metrics`; empty or absent: open. */
  metricsToken?: string;
  /** The cursor not written for this long, while there is a cursor, is `stale` (default 120 s). */
  staleSeconds?: number;
  /** More lines for `/metrics` (the broker adds its own). */
  extraMetrics?: () => string[];
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function opsRoutes(o: OpsOptions): Route[] {
  const stale = o.staleSeconds ?? 120;
  let probed: { at: number; result: { status: "ok" | "failing" | "unknown"; endpoint: string | null; latencyMs?: number; error?: string } } | null = null;

  async function rpcState(nowMs: number) {
    if (!o.rpcProbe) return { status: "unknown" as const, endpoint: null };
    if (probed && nowMs - probed.at < 10_000) return probed.result;
    const started = Date.now();
    try {
      const r = await Promise.race([o.rpcProbe(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3_000))]);
      probed = { at: nowMs, result: { status: "ok", endpoint: r.endpoint ?? null, latencyMs: Date.now() - started } };
    } catch (error) {
      probed = { at: nowMs, result: { status: "failing", endpoint: null, error: error instanceof Error ? error.message.slice(0, 120) : "error" } };
    }
    return probed.result;
  }

  return [
    {
      method: "GET",
      pattern: "/healthz",
      circleScoped: false,
      handler: async ({ db, now }) => {
        const nowMs = now();
        const started = Date.now();
        const cursors = readCursors(db);
        const dbMs = Date.now() - started;
        const rpc = await rpcState(nowMs);
        const first = cursors?.[0];
        const lag = first === undefined ? null : Number(first.lag_blocks);
        const since = first === undefined ? null : Math.max(0, Math.round((nowMs - Number(first.updated_at)) / 1000));
        const problems: string[] = [];
        let status: "ok" | "degraded" | "down" = "ok";
        if (cursors === null) {
          status = "down";
          problems.push("database tidak menjawab");
        } else if (first === undefined) {
          status = "down";
          problems.push("indexer belum bootstrap");
        } else {
          if (lag! > DEGRADED_LAG_BLOCKS) problems.push(`indexer tertinggal ${lag} blok`);
          if (since! > stale) problems.push(`cursor indexer tidak ditulis ${since} detik`);
          if (rpc.status === "failing") problems.push("RPC tidak menjawab");
          if (problems.length > 0) status = "degraded";
        }
        return {
          status: status === "down" ? 503 : 200,
          body: {
            status,
            time: new Date(nowMs).toISOString(),
            uptimeSeconds: Math.round((nowMs - o.telemetry.startedAtMs) / 1000),
            db: { ok: cursors !== null, latencyMs: dbMs },
            indexer: first === undefined ? null : { lagBlocks: lag, lastBlockHeight: Number(first.last_block_height), headBlockHeight: Number(first.head_block_height), secondsSinceUpdate: since, stale: since! > stale },
            rpc,
            problems,
          },
        };
      },
    },
    {
      method: "GET",
      pattern: "/metrics",
      circleScoped: false,
      handler: ({ db, now, headers }) => {
        if (o.metricsToken) {
          const given = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
          if (!same(given, o.metricsToken)) throw new ApiError(401, "invalid_signature", "metrics butuh Authorization: Bearer <token>", {});
        }
        return { status: 200, body: null, raw: { contentType: "text/plain; version=0.0.4; charset=utf-8", text: renderMetrics(o.telemetry, db, now(), o.extraMetrics?.() ?? []) } };
      },
    },
  ];
}
