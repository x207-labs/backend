import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { x207Middleware, X207ExtraSource, type X207Middleware } from "@x207/scheme";
import type { AccessGrant } from "@x207/core";
import { BrokerTelemetry, healthz, metrics, routeLabel, type RouteLabel } from "./ops.js";
import type { BrokerStore } from "./store.js";
import { guardVoucher } from "./in-flight.js";
import { DispatchError, type Dispatcher } from "./dispatcher.js";
import { attestationBody, NONCE, NoAttestation, type Attestor } from "./attest/index.js";
import type { ClassBAdapter } from "./keys/class-b.js";
import { ACCESS_PATH, createProviderRoutes, type ProviderRoutesOptions } from "./provider/routes.js";
import { createProxyHandler, createUsageHandler, matchProxy, USAGE_PATH, type ProxyOptions } from "./proxy/handler.js";

export interface BrokerServerOptions {
  dispatcher: Dispatcher;
  classB: ClassBAdapter;
  facilitatorUrl: string;
  circleId: string;
  /** Account of the broker; only a default for the middleware, every grant route pays the grantor. */
  brokerAccount: string;
  extra?: X207ExtraSource;
  fetch?: typeof fetch;
  /** Class C proxy (BK-008). Without it `/grants/{id}/proxy/*` is `class_not_supported`. */
  /** P2 rent of an access at a provider (BE-060): `/grants/{id}/access`. Without it these paths are `class_not_supported`. */
  provider?: Omit<ProviderRoutesOptions, "dispatcher" | "facilitatorUrl" | "circleId" | "brokerAccount" | "extra" | "creditPrice" | "fetch">;
  /** State of the broker for `/healthz` and `/metrics` (BE-071). */
  store?: BrokerStore;
  now?: () => number;
  /** BK-009: the attestation that `GET /attestation` answers. Default `NoAttestation`: `{"mode":"none"}`. */
  attestor?: Attestor;
  /** Bearer token for `/metrics`. */
  metricsToken?: string;
  proxy?: Omit<ProxyOptions, "dispatcher" | "facilitatorUrl" | "circleId" | "brokerAccount" | "extra" | "creditPrice" | "fetch">;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Credit base units (6 decimals) to the decimal string that `buildPaymentRequirements` turns back into the same amount. */
export function creditPrice(baseUnits: string): string {
  const n = BigInt(baseUnits);
  return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0")}`;
}

const LEASE_PATH = /^\/grants\/(0|[1-9]\d*)\/lease$/;

/**
 * BK-002 and BK-006: `GET /grants/{grantId}/lease`. The grant is read first (404 `grant_not_found`, 403 `grant_not_active` or
 * `grant_revoked`, nothing is charged). Then `@x207/scheme` answers 402 with `payTo` = grantor, `extra.grantId` and the price of one
 * day from `meter`; after `/verify` the key is added (or the rent extended), and `/settle` follows only when that worked.
 */
export function createBrokerHandler(options: BrokerServerOptions): (request: Request) => Promise<Response> {
  const extra = options.extra ?? new X207ExtraSource({ facilitatorUrl: options.facilitatorUrl.replace(/\/+$/, ""), ...(options.fetch ? { fetch: options.fetch } : {}) });
  const proxy = options.proxy
    ? createProxyHandler({
        ...options.proxy, dispatcher: options.dispatcher, facilitatorUrl: options.facilitatorUrl, circleId: options.circleId,
        brokerAccount: options.brokerAccount, extra, creditPrice, ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : undefined;
  const usage = options.proxy ? createUsageHandler({ dispatcher: options.dispatcher, classC: options.proxy.classC, store: options.proxy.store, ...(options.proxy.limits ? { limits: options.proxy.limits } : {}) }) : undefined;
  const providerRoutes = options.provider
    ? createProviderRoutes({
        ...options.provider, dispatcher: options.dispatcher, facilitatorUrl: options.facilitatorUrl, circleId: options.circleId, brokerAccount: options.brokerAccount, extra, creditPrice,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : undefined;
  const telemetry = new BrokerTelemetry(options.now?.() ?? Date.now());
  const ops = { ...(options.store ? { store: options.store } : {}), ...(options.provider ? { manager: options.provider.manager } : {}), now: options.now ?? Date.now, telemetry, ...(options.metricsToken ? { metricsToken: options.metricsToken } : {}) };
  const inner = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return healthz(ops);
    if (url.pathname === "/metrics") return metrics(ops, request);
    if (url.pathname === "/attestation") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" });
      const nonce = url.searchParams.get("nonce");
      if (nonce !== null && !NONCE.test(nonce)) return json(400, { error: "bad_nonce", message: "nonce: 8 to 64 bytes in hex" });
      return json(200, await attestationBody(options.attestor ?? new NoAttestation(), nonce ?? undefined));
    }
    if (ACCESS_PATH.test(url.pathname)) return providerRoutes ? providerRoutes(request) : json(501, { error: "class_not_supported" });
    if (url.pathname === "/health") return json(200, { ok: true });
    if (USAGE_PATH.test(url.pathname)) return usage ? usage(request) : json(501, { error: "class_not_supported" });
    const target = matchProxy(url);
    if (target !== null) return proxy ? proxy(request, target) : json(501, { error: "class_not_supported" });
    const match = LEASE_PATH.exec(url.pathname);
    if (request.method !== "GET" || match === null) return json(404, { error: "not_found" });
    const grantId = Number(match[1]);

    let grant: AccessGrant;
    try {
      grant = await options.dispatcher.open(grantId);
      options.dispatcher.adapterFor(grant);
    } catch (error) {
      if (error instanceof DispatchError) return json(error.status, { error: error.code, message: error.message });
      return json(502, { error: "chain_unavailable", message: (error as Error).message });
    }
    if (grant.class !== "B") return json(501, { error: "class_not_supported" });

    // BK-005: the amount of the 402 is the grant price of one day, nothing the broker invents
    const charge = options.classB.meter(grant, { quantity: 1 });
    const middleware: X207Middleware = x207Middleware({
      routes: { [url.pathname]: { price: creditPrice(charge.amount), description: `Lease of grant ${grantId}`, grant: () => ({ grantId, payTo: grant.grantor }) } },
      facilitatorUrl: options.facilitatorUrl, circleId: options.circleId, payTo: options.brokerAccount, extra,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return guardVoucher(request, () => middleware(request, async (paid) => {
      // only the lessee pays for its own lease
      const payer = payerOf(paid.headers.get("PAYMENT-SIGNATURE"));
      if (payer !== grant.grantee) return json(403, { error: "payer_not_grantee", message: `grant ${grantId} is leased to ${grant.grantee}` });
      try {
        const { delivery } = await options.dispatcher.deliver(grantId, 1);
        return json(200, { grantId, ...(delivery as object) });
      } catch (error) {
        if (error instanceof DispatchError) return json(error.status, { error: error.code, message: error.message });
        return json(502, { error: "delivery_failed", message: (error as Error).message });
      }
    }));
  };
  // the counters see every answer, by the name of the route (never the path, which holds a grant id)
  return async (request) => {
    const label: RouteLabel = routeLabel(new URL(request.url).pathname, request.method);
    let status = 500;
    try {
      const response = await inner(request);
      status = response.status;
      return response;
    } finally {
      telemetry.observe(label, request.method, status);
    }
  };
}

function payerOf(header: string | null): string | undefined {
  if (header === null) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload?: { voucher?: { payer?: string } } };
    return payload.payload?.voucher?.payer;
  } catch {
    return undefined;
  }
}

/** Node `http` adapter for a web `Request` handler. */
export function serve(handler: (request: Request) => Promise<Response>, port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    // the address of the peer for the rate limit; a header with this name sent by the caller is overwritten
    headers.set("x-x207-peer", req.socket.remoteAddress ?? "unknown");
    // B7-P5: nothing a caller sends may throw outside the `try`: a method that fetch refuses (TRACE, CONNECT), a Host that is not a host, a target that is not a path. The URL is fixed
    // (`http://localhost`) and only the path and the query of the request line are taken from the caller
    let response: Response;
    try {
      const method = req.method ?? "GET";
      const target = req.url ?? "/";
      if (["TRACE", "TRACK", "CONNECT"].includes(method.toUpperCase())) response = json(405, { error: "method_not_allowed", message: `${method} is not supported` });
      else if (!target.startsWith("/") || target.startsWith("//")) response = json(400, { error: "bad_request", message: "the request target must be a path" });
      else {
        const request = new Request(`http://localhost${target}`, {
          method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Readable.toWeb(req) as never, duplex: "half" } as object),
        });
        response = await handler(request);
      }
    } catch (error) {
      response = json(error instanceof TypeError ? 400 : 500, { error: error instanceof TypeError ? "bad_request" : "internal", message: (error as Error).message });
    }
    try {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.destroy();
    }
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })),
  );
}
