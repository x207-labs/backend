import type { AuditLog } from "../audit.js";

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

/** The request is inside the scope: method listed and the path under one prefix (a prefix matches whole segments). */
export function inScope(scope: ProxyScope, method: string, path: string): boolean {
  if (!scope.methods.includes(method.toUpperCase())) return false;
  if (path.split("/").includes("..")) return false;
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
    if (secret === undefined || secret === "") throw new Error(`secret variable ${provider.secretEnv} is not set`);
    return [provider.header ?? "authorization", `${provider.prefix ?? "Bearer "}${secret}`];
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

/** Reads `BROKER_PROVIDERS`, a JSON list of `{asset_type, base_url, secret_env, header?, prefix?}`. */
export function providersFromEnv(env: Record<string, string | undefined>): ProviderConfig[] {
  const raw = env.BROKER_PROVIDERS;
  if (raw === undefined || raw.trim() === "") return [];
  const parsed = JSON.parse(raw) as Array<{ asset_type?: string; base_url?: string; secret_env?: string; header?: string; prefix?: string }>;
  return parsed.map((p) => {
    if (!p.asset_type || !p.base_url || !p.secret_env) throw new Error("BROKER_PROVIDERS entries need asset_type, base_url and secret_env");
    return { assetType: p.asset_type, baseUrl: p.base_url, secretEnv: p.secret_env, ...(p.header ? { header: p.header } : {}), ...(p.prefix === undefined ? {} : { prefix: p.prefix }) };
  });
}
