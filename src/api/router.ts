import type Database from "better-sqlite3";

export interface CircleRow {
  circle_id: string;
  contract_id: string;
  network: string;
}

export interface RouteContext {
  db: Database.Database;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Current time in ms (can be replaced in tests). */
  now: () => number;
  /** Set for `circleScoped` routes. */
  circle: CircleRow;
  /** JSON body of a `POST` request; `undefined` for `GET`. */
  body: unknown;
  /** Request headers (lowercase names), for routes that check `authorization` (`GET /metrics`). */
  headers: Record<string, string | string[] | undefined>;
  /** Address of the caller as the abuse limiter sees it (last `X-Forwarded-For` hop behind a trusted proxy). BE-114: the faucet limits per address. */
  ip?: string;
}

export interface RouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Plain-text answer as is (`GET /metrics`), not JSON. */
  raw?: { contentType: string; text: string };
}

export interface Route {
  method: "GET" | "POST";
  /** A `{name}` segment becomes a parameter, e.g. `/x207/circles/{circle}/members/{account}`. */
  pattern: string;
  /** Route under `/x207/circles/{circle}`: the circle and D9 readiness are checked before the handler. */
  circleScoped: boolean;
  /** BE-114: a POST that is served even when the server is read-only (the faucet holds no settlement key; it only pays out test funds). Default false. */
  allowInReadOnly?: boolean;
  handler: (ctx: RouteContext) => RouteResult | Promise<RouteResult>;
}

export interface Match {
  route: Route;
  params: Record<string, string>;
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): Match | null {
  const segments = pathname.split("/").filter((s) => s.length > 0);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.pattern.split("/").filter((s) => s.length > 0);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const ok = pattern.every((part, i) => {
      const seg = segments[i] as string;
      if (part.startsWith("{") && part.endsWith("}")) {
        try {
          params[part.slice(1, -1)] = decodeURIComponent(seg);
        } catch {
          return false;
        }
        return true;
      }
      return part === seg;
    });
    if (ok) return { route, params };
  }
  return null;
}
