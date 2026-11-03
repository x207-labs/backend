// Health and metrics of the broker (BE-071): `GET /healthz` and `GET /metrics` (Prometheus text). The revoke queues are what an operator must watch: a class B lease past its paid day that is still
// open, and a provider access in `revoke_pending` (the provider failed and the manager retries). Labels are fixed names, never a grant id, an account, a path or a handle.
import { timingSafeEqual } from "node:crypto";
import type { ProviderAccessManager } from "./provider/manager.js";
import type { BrokerStore } from "./store.js";

export type RouteLabel = "lease" | "proxy" | "access" | "access_challenge" | "access_stop" | "usage" | "health" | "healthz" | "metrics" | "unmatched";

export class BrokerTelemetry {
  readonly #requests = new Map<string, number>();
  readonly #limited = new Map<string, number>();
  readonly startedAtMs: number;
  constructor(startedAtMs: number = Date.now()) {
    this.startedAtMs = startedAtMs;
  }
  observe(route: RouteLabel, method: string, status: number): void {
    const key = `${method}\u0000${route}\u0000${status}`;
    this.#requests.set(key, (this.#requests.get(key) ?? 0) + 1);
    if (status === 429) this.#limited.set(route, (this.#limited.get(route) ?? 0) + 1);
  }
  render(): string[] {
    const out = ["# HELP x207_broker_http_requests_total Requests by method, route and status.", "# TYPE x207_broker_http_requests_total counter"];
    for (const [key, n] of [...this.#requests.entries()].sort()) {
      const [method, route, code] = key.split("\u0000");
      out.push(`x207_broker_http_requests_total{method="${method}",route="${route}",code="${code}"} ${n}`);
    }
    out.push("# HELP x207_broker_rate_limited_total Requests answered 429, by route.", "# TYPE x207_broker_rate_limited_total counter");
    for (const [route, n] of [...this.#limited.entries()].sort()) out.push(`x207_broker_rate_limited_total{route="${route}"} ${n}`);
    return out;
  }
}

export function routeLabel(pathname: string, method: string): RouteLabel {
  if (pathname === "/health") return "health";
  if (pathname === "/healthz") return "healthz";
  if (pathname === "/metrics") return "metrics";
  if (/^\/grants\/\d+\/lease$/.test(pathname)) return "lease";
  if (/^\/grants\/\d+\/proxy(\/.*)?$/.test(pathname)) return "proxy";
  if (/^\/grants\/\d+\/usage$/.test(pathname)) return "usage";
  if (/^\/grants\/\d+\/access$/.test(pathname)) return "access";
  if (/^\/grants\/\d+\/access\/challenge$/.test(pathname)) return "access_challenge";
  if (/^\/grants\/\d+\/access\/stop$/.test(pathname)) return "access_stop";
  void method;
  return "unmatched";
}

export interface BrokerOps {
  store?: BrokerStore;
  manager?: ProviderAccessManager;
  now: () => number;
  telemetry: BrokerTelemetry;
  metricsToken?: string;
}

interface Queues {
  dbOk: boolean;
  leasesOpen: number;
  leasesOverdue: number;
  providerActive: number;
  providerRevokePending: number;
  providerRetryOverdue: number;
}

function queues(o: BrokerOps): Queues {
  const q: Queues = { dbOk: true, leasesOpen: 0, leasesOverdue: 0, providerActive: 0, providerRevokePending: 0, providerRetryOverdue: 0 };
  const now = o.now();
  try {
    if (o.store) {
      const open = o.store.openLeases();
      q.leasesOpen = open.length;
      q.leasesOverdue = open.filter((l) => l.paidUntilMs <= now).length;
    }
    if (o.manager) {
      for (const a of o.manager.list()) {
        if (a.status === "active") q.providerActive += 1;
        if (a.status === "revoke_pending") {
          q.providerRevokePending += 1;
          if ((a.nextRetryMs ?? 0) <= now) q.providerRetryOverdue += 1;
        }
      }
    }
  } catch {
    q.dbOk = false;
  }
  return q;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** `GET /healthz`: 200 with `ok` or `degraded` (a revoke is overdue), 503 with `down` (the database does not answer). */
export function healthz(o: BrokerOps): Response {
  const q = queues(o);
  const problems: string[] = [];
  if (q.leasesOverdue > 0) problems.push(`${q.leasesOverdue} sewa kelas B lewat hari bayar dan belum ditutup`);
  if (q.providerRetryOverdue > 0) problems.push(`${q.providerRetryOverdue} akses penyedia menunggu pencabutan yang lewat waktu coba lagi`);
  const status = !q.dbOk ? "down" : problems.length > 0 ? "degraded" : "ok";
  return json(status === "down" ? 503 : 200, { status, time: new Date(o.now()).toISOString(), uptimeSeconds: Math.round((o.now() - o.telemetry.startedAtMs) / 1000), db: { ok: q.dbOk }, revokeQueue: { leasesOverdue: q.leasesOverdue, providerRevokePending: q.providerRevokePending }, problems });
}

/** `GET /metrics`, with `METRICS_TOKEN` as a bearer token when it is set. */
export function metrics(o: BrokerOps, request: Request): Response {
  if (o.metricsToken) {
    const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!same(given, o.metricsToken)) return json(401, { error: "invalid_signature", message: "metrics butuh Authorization: Bearer <token>" });
  }
  const q = queues(o);
  const lines = [
    ...o.telemetry.render(),
    "# HELP x207_broker_db_up 1 when the database of the broker answers.", "# TYPE x207_broker_db_up gauge", `x207_broker_db_up ${q.dbOk ? 1 : 0}`,
    "# HELP x207_broker_leases_open Class B leases with the key on the account, not closed.", "# TYPE x207_broker_leases_open gauge", `x207_broker_leases_open ${q.leasesOpen}`,
    "# HELP x207_broker_revoke_queue Accesses waiting to be taken back: a class B lease past its paid day (lease), a provider access whose revoke failed (provider), and the part of those whose retry is due (provider_due).",
    "# TYPE x207_broker_revoke_queue gauge",
    `x207_broker_revoke_queue{kind="lease"} ${q.leasesOverdue}`, `x207_broker_revoke_queue{kind="provider"} ${q.providerRevokePending}`, `x207_broker_revoke_queue{kind="provider_due"} ${q.providerRetryOverdue}`,
    "# HELP x207_broker_provider_access_active Provider accesses that are open.", "# TYPE x207_broker_provider_access_active gauge", `x207_broker_provider_access_active ${q.providerActive}`,
  ];
  return new Response(`${lines.join("\n")}\n`, { status: 200, headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } });
}
