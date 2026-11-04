import { JsonRpcProvider } from "near-api-js";
import { UnknownBlockError } from "near-api-js/rpc-errors";

export type RpcBlock = Awaited<ReturnType<JsonRpcProvider["viewBlock"]>>;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 30_000;

export interface EndpointFailure {
  endpoint: string;
  error: unknown;
}

export interface EndpointChange {
  from: string;
  to: string;
  failures: EndpointFailure[];
}

export interface RpcClientOptions {
  /** Priority order: primary first, then fallback. */
  endpoints: string[];
  /** Time limit for one operation per endpoint; near-api-js fetch has no timeout of its own. */
  timeoutMs?: number;
  /** How long a failed endpoint is skipped before it is tried again as the first choice. */
  cooldownMs?: number;
  onEndpointChange?: (change: EndpointChange) => void;
  now?: () => number;
}

/** All endpoints failed: the caller must not advance the cursor and must try again. */
export class AllRpcEndpointsFailedError extends Error {
  constructor(readonly failures: EndpointFailure[]) {
    const detail = failures.map((f) => `${f.endpoint}: ${String(f.error)}`).join("; ");
    super(`All RPC endpoints failed: ${detail}`);
    this.name = "AllRpcEndpointsFailedError";
  }
}

/** The endpoint has not finalized the requested height yet, so its answer cannot be trusted. */
export class EndpointBehindError extends Error {
  constructor(
    readonly height: number,
    readonly finalHead: number,
  ) {
    super(`Requested height ${height} is above final head ${finalHead}`);
    this.name = "EndpointBehindError";
  }
}

interface Endpoint {
  url: string;
  provider: JsonRpcProvider;
  cooldownUntil: number;
  finalHead: number;
}

export class FailoverRpcClient {
  readonly #endpoints: Endpoint[];
  readonly #timeoutMs: number;
  readonly #cooldownMs: number;
  readonly #onEndpointChange: ((change: EndpointChange) => void) | undefined;
  readonly #now: () => number;
  #active: Endpoint;

  constructor(options: RpcClientOptions) {
    const [first] = options.endpoints;
    if (first === undefined) throw new Error("At least one RPC endpoint is required");
    // retries 1: failover is faster than the default near-api-js backoff (12 attempts).
    this.#endpoints = options.endpoints.map((url) => ({
      url,
      provider: new JsonRpcProvider({ url }, { retries: 1 }),
      cooldownUntil: 0,
      finalHead: -1,
    }));
    this.#active = this.#endpoints[0]!;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#onEndpointChange = options.onEndpointChange;
    this.#now = options.now ?? Date.now;
  }

  /** URL that answered the last request; value of `indexer_cursor.rpc_endpoint`. */
  get activeEndpoint(): string {
    return this.#active.url;
  }

  async getFinalBlock(): Promise<RpcBlock> {
    return this.#withFailover((endpoint) => this.#readFinalBlock(endpoint));
  }

  /**
   * Final block at height `height`, or `null` if the chain skipped that height.
   * `null` is only returned if the endpoint that answered is already final above `height`;
   * an endpoint that lags behind is treated as failed so the cursor does not jump over a block.
   */
  async getBlock(height: number): Promise<RpcBlock | null> {
    return this.#withFailover(async (endpoint) => {
      if (endpoint.finalHead < height) await this.#readFinalBlock(endpoint);
      if (endpoint.finalHead < height) throw new EndpointBehindError(height, endpoint.finalHead);
      try {
        return await endpoint.provider.viewBlock({ blockId: height });
      } catch (error) {
        if (error instanceof UnknownBlockError) return null;
        throw error;
      }
    });
  }

  /** Arbitrary provider operation (e.g. `chunk`, `tx`) with the same timeout and failover. */
  async use<T>(operation: (provider: JsonRpcProvider) => Promise<T>): Promise<T> {
    return this.#withFailover((endpoint) => operation(endpoint.provider));
  }

  async #readFinalBlock(endpoint: Endpoint): Promise<RpcBlock> {
    const block = await endpoint.provider.viewBlock({ finality: "final" });
    endpoint.finalHead = block.header.height;
    return block;
  }

  async #withFailover<T>(operation: (endpoint: Endpoint) => Promise<T>): Promise<T> {
    const now = this.#now();
    const ready = this.#endpoints.filter((e) => e.cooldownUntil <= now);
    const cooling = this.#endpoints.filter((e) => e.cooldownUntil > now);
    const failures: EndpointFailure[] = [];

    for (const endpoint of [...ready, ...cooling]) {
      try {
        const result = await withTimeout(operation(endpoint), this.#timeoutMs);
        endpoint.cooldownUntil = 0;
        this.#setActive(endpoint, failures);
        return result;
      } catch (error) {
        endpoint.cooldownUntil = this.#now() + this.#cooldownMs;
        failures.push({ endpoint: endpoint.url, error });
      }
    }
    throw new AllRpcEndpointsFailedError(failures);
  }

  #setActive(endpoint: Endpoint, failures: EndpointFailure[]): void {
    if (endpoint === this.#active) return;
    const from = this.#active.url;
    this.#active = endpoint;
    this.#onEndpointChange?.({ from, to: endpoint.url, failures });
  }
}

/** Create the client from `NEAR_RPC_PRIMARY_URL` and `NEAR_RPC_FALLBACK_URL`; there is no default URL. */
export function rpcClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: Omit<RpcClientOptions, "endpoints"> = {},
): FailoverRpcClient {
  const endpoints = ["NEAR_RPC_PRIMARY_URL", "NEAR_RPC_FALLBACK_URL"].map((name) => {
    const value = env[name];
    if (!value) throw new Error(`Missing env ${name}`);
    return new URL(value).href.replace(/\/$/, "");
  });
  return new FailoverRpcClient({ ...options, endpoints });
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`RPC timeout after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
