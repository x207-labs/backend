// BE-068: the OpenAPI 3.1 document of the read API, the marketplace and the broker. `node scripts/build-openapi.mjs` writes docs/openapi.json; the test of the router (test/api/openapi.test.ts)
// runs this builder and compares the result with the file, so a route that is added, removed or changed without rebuilding the document fails the build.
//
// How it is made: the routes are read from the sources (`method: "GET", pattern: "…"` of every module under src/). For each route the text up to the next route is its handler; from it the
// script takes the query parameters (`query.get`, `parseLimit`, `decodeCursor`), the fields of the body (`body as { … }`), the status of success, and the codes of `new ApiError(status, "code")`.
// The text before the first route of a file (the helpers of the module) counts for all the routes of that file. The errors are therefore "what this route can answer", a little more than a given
// request will. Response bodies are described only where the shape is the same for many routes (the error envelope and the page `{items, nextCursor}`); the rest is an object, and the spec 5a to 5h
// of the vault names the fields. The broker is not a router of this kind; its routes are listed by hand below.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));

/** `{ method, pattern, file, text, prelude }` for every route in the sources, in file order. */
export function sourceRoutes() {
  const out = [];
  for (const file of walk(join(ROOT, "src")).sort()) {
    const src = readFileSync(file, "utf8");
    const re = /method:\s*"(GET|POST)",\s*\n?\s*pattern:\s*"([^"]+)"/g;
    const hits = [];
    for (let m = re.exec(src); m; m = re.exec(src)) hits.push({ method: m[1], pattern: m[2], at: m.index });
    hits.forEach((h, i) => out.push({ method: h.method, pattern: h.pattern, file: relative(ROOT, file), text: src.slice(h.at, hits[i + 1]?.at ?? src.length), prelude: src.slice(0, hits[0].at) }));
  }
  return out;
}

const ERROR_STATUS_TEXT = {
  400: "The request is not valid.", 401: "A signature does not match the voucher key of the account.", 403: "Not allowed for this account.", 404: "Not found.", 409: "The state does not allow this.",
  413: "The body is larger than `API_MAX_BODY_BYTES` (BE-066).", 429: "Too many requests; see the header `Retry-After` (BE-066).", 501: "Not available.", 502: "A service behind the API failed.", 503: "A dependency is not ready.",
};
const codesOf = (text) => [...text.matchAll(/new ApiError\(\s*(\d{3}),\s*"([a-z_0-9]+)"/g)].map((m) => [Number(m[1]), m[2]]);

function operationOf(route) {
  const { method, pattern, text, prelude } = route;
  const circleScoped = pattern.startsWith("/x207/circles/{circle}");
  const params = [...pattern.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
  const queryNames = new Set([...text.matchAll(/query\.get\("(\w+)"\)/g)].map((m) => m[1]));
  if (/parseLimit\(query\)/.test(text)) queryNames.add("limit");
  if (/decodeCursor\(query\)/.test(text)) queryNames.add("cursor");
  for (const name of [...queryNames].sort()) {
    params.push({ name, in: "query", required: false, schema: name === "limit" ? { type: "integer", minimum: 1, maximum: 200, default: 50 } : { type: "string" } });
  }
  const isList = queryNames.has("limit");
  // errors: this handler, plus the helpers before the first route of the file
  const found = new Map();
  for (const [status, code] of [...codesOf(prelude), ...codesOf(text)]) {
    if (!found.has(status)) found.set(status, new Set());
    found.get(status).add(code);
  }
  if (/invalidRequest\(/.test(prelude + text) || /asApiError\(/.test(prelude + text)) (found.get(400) ?? found.set(400, new Set()).get(400)).add("invalid_request");
  if (/assertOpenRoom\(/.test(prelude + text)) (found.get(409) ?? found.set(409, new Set()).get(409)).add("open_limit_reached");
  if (circleScoped) {
    (found.get(404) ?? found.set(404, new Set()).get(404)).add("circle_not_found");
    (found.get(503) ?? found.set(503, new Set()).get(503)).add("indexer_unavailable");
  }
  (found.get(429) ?? found.set(429, new Set()).get(429)).add("rate_limited");
  if (method === "POST") (found.get(413) ?? found.set(413, new Set()).get(413)).add("payload_too_large");
  const responses = {};
  const successes = [...text.matchAll(/status:\s*(20[01])\b/g)].map((m) => m[1]);
  for (const code of [...new Set(successes.length > 0 ? successes : [method === "POST" ? "200" : "200"])].sort()) {
    responses[code] = { description: code === "201" ? "Created." : "OK.", content: { "application/json": { schema: isList ? { $ref: "#/components/schemas/Page" } : { type: "object", additionalProperties: true } } } };
  }
  for (const [status, codes] of [...found.entries()].sort((a, b) => a[0] - b[0])) {
    responses[String(status)] = {
      description: ERROR_STATUS_TEXT[status] ?? "Error.",
      ...(status === 429 ? { headers: { "Retry-After": { description: "Seconds to wait.", schema: { type: "integer", minimum: 1 } } } } : {}),
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, examples: { codes: { value: { error: { code: [...codes].sort()[0], message: "…", details: {} } } } } } },
      "x-error-codes": [...codes].sort(),
    };
  }
  const op = {
    operationId: `${method.toLowerCase()}_${pattern.replace(/^\/x207\/(circles\/\{circle\}\/)?/, "").replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
    summary: summaryOf(route),
    tags: [tagOf(route)],
    ...(circleScoped ? {} : {}),
    parameters: params,
    responses,
    "x-source": route.file,
  };
  if (method === "POST") {
    const body = bodyFields(route);
    op.requestBody = { required: true, content: { "application/json": { schema: body } } };
  }
  return op;
}

/** The fields the handler reads from the body, with a type where the name tells it (`signature` is text, `notice` an object, `signatures` a list). */
function bodyFields(route) {
  const names = new Set();
  for (const text of [route.text, route.prelude]) {
    for (const m of text.matchAll(/body as (?:\{|Record<[^>]*>|\w+)\s*(?:\|\s*null)?\s*\{?([^}]*)\}?/g)) {
      for (const f of m[1].matchAll(/(\w+)\??:/g)) names.add(f[1]);
    }
    if (names.size > 0) break;
  }
  const typeOf = (n) => (n === "signature" || n.endsWith("_hash") || n.endsWith("Hash") || n === "account" || n === "proof" || n === "grantee_ref" ? { type: "string" } : n === "signatures" || n === "vouchers" ? { type: "array", items: { type: "object", additionalProperties: true } } : {});
  return names.size === 0
    ? { type: "object", additionalProperties: true }
    : { type: "object", properties: Object.fromEntries([...names].sort().map((n) => [n, typeOf(n)])), additionalProperties: true };
}

function tagOf({ pattern, file }) {
  if (pattern.startsWith("/x207/settlement")) return "settlement";
  if (file.includes("marketplace")) return "marketplace";
  return "read-api";
}
function summaryOf({ method, pattern }) {
  const parts = pattern.replace(/^\/x207\/(circles\/\{circle\}\/)?/, "").split("/");
  const words = parts.map((p) => (p.startsWith("{") ? `by ${p.slice(1, -1)}` : p.replace(/-/g, " ")));
  return `${method === "GET" ? "Read" : "Send"} ${words.join(" ")}`;
}

// ---- the broker (separate server, `{error, message}` envelope) ---------------------------------------------------------------------------------------------------------------
export const BROKER_ROUTES = [
  { method: "GET", path: "/health", summary: "Health of the broker", errors: {} },
  { method: "GET", path: "/grants/{grantId}/lease", summary: "Rent of a class B grant for one day (x402: 402 first, then the voucher)", errors: { 402: ["payment_required"], 403: ["grant_not_active", "grant_revoked"], 404: ["grant_not_found"], 501: ["class_not_supported"], 502: ["chain_unavailable"] } },
  { method: "POST", path: "/grants/{grantId}/proxy/{path}", summary: "Call through the class C proxy (x402); the rest of the path goes to the provider", errors: { 402: ["payment_required"], 403: ["grant_scope_denied", "payer_not_grantee"], 429: ["grant_quota_exceeded"], 501: ["class_not_supported", "secret_hosted_forbidden"], 502: ["provider_unreachable", "provider_redirect", "secret_not_configured", "delivery_failed"] } },
  { method: "GET", path: "/grants/{grantId}/usage", summary: "Calls billed through a class C grant, per epoch, and what they cost (BE-070); the buyer compares it with its own count", errors: { 404: ["grant_not_found"], 501: ["class_not_supported"] } },
  { method: "GET", path: "/grants/{grantId}/access", summary: "State of the access at a provider, the bill of today, and a revoke that is pending", errors: { 404: ["access_not_found", "grant_not_found"], 501: ["class_not_supported"] } },
  { method: "POST", path: "/grants/{grantId}/access", summary: "Pay one day (x402) and open the access at the provider; body {grantee_ref, proof?}", errors: { 402: ["payment_required"], 403: ["grantee_ref_mismatch", "grantee_ref_unverified", "payer_not_grantee"], 413: ["payload_too_large"], 501: ["class_not_supported"] } },
  { method: "GET", path: "/grants/{grantId}/access/challenge", summary: "The challenge to sign for the proof of the grantee_ref", errors: { 404: ["grant_not_found"], 501: ["class_not_supported"] } },
  { method: "POST", path: "/grants/{grantId}/access/stop", summary: "The lessee ends the rent; body {notice, signature}", errors: { 401: ["invalid_signature"], 403: ["not_grantee"], 404: ["access_not_found"], 413: ["payload_too_large"] } },
];

export function buildOpenApi() {
  const paths = {};
  const operations = sourceRoutes().map((r) => ({ route: r, op: operationOf(r) }));
  for (const { route, op } of operations.sort((a, b) => (a.route.pattern + a.route.method).localeCompare(b.route.pattern + b.route.method))) {
    (paths[route.pattern] ??= {})[route.method.toLowerCase()] = op;
  }
  for (const b of BROKER_ROUTES) {
    const responses = { [b.method === "GET" ? "200" : "200"]: { description: "OK.", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } };
    for (const [status, codes] of Object.entries({ ...b.errors, 429: ["rate_limited"] })) {
      responses[status] = { description: ERROR_STATUS_TEXT[status] ?? (status === "402" ? "Payment required (x402): the body lists the requirements." : "Error."), content: { "application/json": { schema: { $ref: "#/components/schemas/BrokerError" } } }, "x-error-codes": codes };
    }
    (paths[b.path] ??= {})[b.method.toLowerCase()] = {
      operationId: `broker_${b.method.toLowerCase()}_${b.path.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      summary: b.summary, tags: ["broker"],
      parameters: [...b.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } })),
      ...(b.method === "POST" ? { requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } } } : {}),
      responses, servers: [{ url: "{broker}", variables: { broker: { default: "http://127.0.0.1:8090" } } }], "x-broker": true,
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "x207 backend, marketplace and broker",
      version: "0.1.0",
      description:
        "Routes of the read API (spec 5a), the marketplace (5b to 5g), the settlement worker and the broker (5h). Generated by `scripts/build-openapi.mjs` from the sources; `test/api/openapi.test.ts` fails when a route and this document differ. " +
        "Error codes are listed per status in `x-error-codes` and are what the route can answer, a little more than one request will. Response bodies are loose (`object`) except the error envelope and the page; the fields are in the spec of the vault. " +
        "The backend answers errors as `{error: {code, message, details}}`; the broker as `{error, message}`. Limits against abuse (BE-066): 429 `rate_limited` with `Retry-After`, 413 `payload_too_large`, 409 `open_limit_reached`.",
    },
    servers: [{ url: "{api}", variables: { api: { default: "http://127.0.0.1:8080" } } }],
    tags: [{ name: "read-api" }, { name: "marketplace" }, { name: "settlement" }, { name: "broker" }],
    paths,
    components: {
      schemas: {
        Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message", "details"], properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "object", additionalProperties: true } } } } },
        BrokerError: { type: "object", required: ["error"], properties: { error: { type: "string" }, message: { type: "string" } } },
        Page: { type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: { type: "object", additionalProperties: true } }, nextCursor: { type: ["string", "null"] } }, additionalProperties: true },
      },
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(ROOT, "docs", "openapi.json"), `${JSON.stringify(buildOpenApi(), null, 2)}\n`);
  console.log("docs/openapi.json written");
}
