import type { AuditLog } from "../audit.js";

/** The variable of the secret of a provider is empty (BE-070): the call answers `502 secret_not_configured`, naming the variable and never a value. */
export class SecretNotConfiguredError extends Error {}

/** A provider whose API the broker calls with the secret of the grantor. */
export interface ProviderConfig {
  assetType: string;
  baseUrl: string;
  /** Header that carries the secret, default `authorization`. */
  header?: string;
  /** Prefix before the secret in that header, default `Bearer `. */
  prefix?: string;
  /** Name of the environment variable that holds the secret. The secret itself never appears in a config object. */
  secretEnv: string;
  /** `true` for a provider of the demo (a local server with a made-up secret). The only kind that the `hosted` mode serves (BE-070, ADR-48): a real key lives only on the machine of its owner. */
  mock?: boolean;
}

/** Class C scope in `limits.scope`: the paths and methods the lessee may call. */
export interface ProxyScope {
  path_prefixes: string[];
  methods: string[];
}

export function parseProxyScope(scope: string): ProxyScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scope);
  } catch {
    throw new Error("scope is not JSON");
  }
  const s = parsed as Partial<ProxyScope> | null;
  if (typeof s !== "object" || s === null) throw new Error("scope must be an object");
  const list = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "");
  if (!list(s.path_prefixes)) throw new Error("scope.path_prefixes must be a non-empty list of strings");
  if (!list(s.methods)) throw new Error("scope.methods must be a non-empty list of strings");
  return { path_prefixes: s.path_prefixes, methods: s.methods.map((m) => m.toUpperCase()) };
}

/**
 * A path that cannot walk out of its prefix once the provider decodes it (security review 2): no encoded slash or backslash, no NUL, no dot
 * segment, plain or percent-encoded. `URL` already folds `.` and `..` segments written with a literal slash; the encoded forms reach the provider as typed.
 */
export function plainPath(path: string): boolean {
  if (/%(2f|5c|00)|[\\\u0000]/i.test(path)) return false;
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) return false;
  }
  return true;
}

/** The request is inside the scope: method listed and the path under one prefix (a prefix matches whole segments). */
export function inScope(scope: ProxyScope, method: string, path: string): boolean {
  if (!scope.methods.includes(method.toUpperCase())) return false;
  if (!plainPath(path)) return false;
  return scope.path_prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

/**
 * Providers by asset type, with the secrets read from the environment when needed and never copied anywhere else. Several providers are served
 * at once (one entry per `assetType`). A secret is rotated by pointing the provider at another variable, or at the same variable after its
 * value was replaced in the environment of the registry: grants name an asset type, not a secret, so no grant is cut by a rotation.
 */
export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderConfig>();
  readonly #versions = new Map<string, number>();
  readonly #env: Record<string, string | undefined>;

  constructor(providers: readonly ProviderConfig[], env: Record<string, string | undefined> = process.env, private readonly audit?: AuditLog) {
    this.#env = env;
    for (const p of providers) {
      this.#providers.set(p.assetType, p);
      this.#versions.set(p.assetType, 1);
    }
  }

  get(assetType: string): ProviderConfig | undefined {
    return this.#providers.get(assetType);
  }

  /** How many secrets this provider has had; goes up by one at each rotation. */
  version(assetType: string): number {
    return this.#versions.get(assetType) ?? 0;
  }

  /** `[header name, header value]` for the call to the provider; throws without naming the value when the variable is empty. */
  authHeader(provider: ProviderConfig): [string, string] {
    const secret = this.#env[provider.secretEnv];
    if (secret === undefined || secret === "") throw new SecretNotConfiguredError(`secret variable ${provider.secretEnv} is not set`);
    return [provider.header ?? "authorization", `${provider.prefix ?? "Bearer "}${secret}`];
  }

  /** `body` with the secret of the provider replaced, for a provider that echoes the request headers back. Binary bodies without the secret are left alone. */
  redact(provider: ProviderConfig, body: ArrayBuffer): ArrayBuffer {
    const secret = this.#env[provider.secretEnv];
    if (secret === undefined || secret === "") return body;
    // B7-P8: the replacement works on the bytes (a binary body is not rewritten through UTF-8) and covers the common encodings of the secret, not only the plain string. It is a net
    // for a provider that echoes the request headers, not a guarantee against a provider that transforms the key in its own way.
    let bytes = Buffer.from(body);
    let changed = false;
    for (const form of secretForms(secret)) {
      const needle = Buffer.from(form, "utf8");
      let at = bytes.indexOf(needle);
      if (at < 0) continue;
      changed = true;
      const parts: Buffer[] = [];
      let from = 0;
      while (at >= 0) {
        parts.push(bytes.subarray(from, at), Buffer.from("[redacted]"));
        from = at + needle.length;
        at = bytes.indexOf(needle, from);
      }
      parts.push(bytes.subarray(from));
      bytes = Buffer.concat(parts);
    }
    if (!changed) return body;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  /** B7-P8: a header value of the answer (`content-type`) with the secret taken out. */
  redactText(provider: ProviderConfig, text: string): string {
    const secret = this.#env[provider.secretEnv];
    if (secret === undefined || secret === "") return text;
    let out = text;
    for (const form of secretForms(secret)) out = out.split(form).join("[redacted]");
    return out;
  }

  /**
   * Switches the provider to the secret in `secretEnv` (default: the same variable, which the caller has just refreshed in the environment given to
   * the registry). Refused, with the old secret kept, when the new variable is empty. The audit entry names the variables, never the values.
   */
  rotate(assetType: string, secretEnv?: string, env?: Record<string, string | undefined>): number {
    const provider = this.#providers.get(assetType);
    if (provider === undefined) throw new Error(`no provider for ${assetType}`);
    if (env !== undefined) Object.assign(this.#env, env);
    const next = secretEnv ?? provider.secretEnv;
    const value = this.#env[next];
    if (value === undefined || value === "") throw new Error(`secret variable ${next} is not set, the old secret stays`);
    this.#providers.set(assetType, { ...provider, secretEnv: next });
    const version = (this.#versions.get(assetType) ?? 1) + 1;
    this.#versions.set(assetType, version);
    this.audit?.record({ kind: "secret_rotated", assetType, from: provider.secretEnv, to: next, secretVersion: version });
    return version;
  }
}

/** The plain secret and its common encodings: percent, base64, hex, JSON-escaped, lower and upper case. Longest first, so a form that contains another is replaced whole. */
function secretForms(secret: string): string[] {
  const forms = new Set<string>([
    secret, encodeURIComponent(secret), Buffer.from(secret, "utf8").toString("base64"), Buffer.from(secret, "utf8").toString("base64url"), Buffer.from(secret, "utf8").toString("hex"),
    JSON.stringify(secret).slice(1, -1), secret.toLowerCase(), secret.toUpperCase(),
  ]);
  return [...forms].filter((f) => f.length >= 4).sort((a, b) => b.length - a.length);
}

/** B7-P9: the host of a provider that may carry the `mock` label in a hosted broker: loopback or a name ending in `.test`, `.localhost` or `.example`. */
const MOCK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|.+\.(test|localhost|example))$/;

/**
 * The asset types of the providers that a `hosted` broker may not serve (BE-070, ADR-48): every provider that is not marked `mock`. A `mock` label is a claim of the operator (B7-P9), so
 * it also needs a base URL that is loopback or a test name, and, when `env` is given, a secret that starts with `mock-`. Empty for `self-hosted`.
 */
export function hostedForbidden(mode: "self-hosted" | "hosted", providers: readonly ProviderConfig[], env?: Record<string, string | undefined>): string[] {
  if (mode !== "hosted") return [];
  return providers
    .filter((p) => {
      if (p.mock !== true) return true;
      let host = "";
      try {
        host = new URL(p.baseUrl).hostname;
      } catch {
        return true;
      }
      if (!MOCK_HOST.test(host)) return true;
      const secret = env?.[p.secretEnv];
      return env !== undefined && secret !== undefined && secret !== "" && !secret.startsWith("mock-");
    })
    .map((p) => p.assetType);
}

/** Reads `BROKER_PROVIDERS`, a JSON list of `{asset_type, base_url, secret_env, header?, prefix?}`. */
export function providersFromEnv(env: Record<string, string | undefined>): ProviderConfig[] {
  const raw = env.BROKER_PROVIDERS;
  if (raw === undefined || raw.trim() === "") return [];
  const parsed = JSON.parse(raw) as Array<{ asset_type?: string; base_url?: string; secret_env?: string; header?: string; prefix?: string; mock?: boolean }>;
  return parsed.map((p) => {
    if (!p.asset_type || !p.base_url || !p.secret_env) throw new Error("BROKER_PROVIDERS entries need asset_type, base_url and secret_env");
    return { assetType: p.asset_type, baseUrl: p.base_url, secretEnv: p.secret_env, ...(p.header ? { header: p.header } : {}), ...(p.prefix === undefined ? {} : { prefix: p.prefix }), ...(p.mock === true ? { mock: true } : {}) };
  });
}
