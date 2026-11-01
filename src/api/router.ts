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
  /** Waktu sekarang dalam ms (bisa diganti di test). */
  now: () => number;
  /** Terisi untuk route `circleScoped`. */
  circle: CircleRow;
}

export interface RouteResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface Route {
  method: "GET";
  /** Segmen `{nama}` menjadi parameter, mis. `/x207/circles/{circle}/members/{account}`. */
  pattern: string;
  /** Route di bawah `/x207/circles/{circle}`: lingkaran dan kesiapan D9 diperiksa sebelum handler. */
  circleScoped: boolean;
  handler: (ctx: RouteContext) => RouteResult;
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
