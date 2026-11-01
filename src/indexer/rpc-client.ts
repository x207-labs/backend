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
  /** Urutan prioritas: utama lebih dulu, lalu cadangan. */
  endpoints: string[];
  /** Batas waktu satu operasi per endpoint; fetch near-api-js sendiri tidak punya timeout. */
  timeoutMs?: number;
  /** Lama endpoint yang gagal dilewati sebelum dicoba lagi sebagai pilihan pertama. */
  cooldownMs?: number;
  onEndpointChange?: (change: EndpointChange) => void;
  now?: () => number;
}

/** Semua endpoint gagal: pemanggil tidak boleh memajukan cursor dan harus mencoba lagi. */
export class AllRpcEndpointsFailedError extends Error {
  constructor(readonly failures: EndpointFailure[]) {
    const detail = failures.map((f) => `${f.endpoint}: ${String(f.error)}`).join("; ");
    super(`All RPC endpoints failed: ${detail}`);
    this.name = "AllRpcEndpointsFailedError";
  }
}

/** Endpoint belum memfinalkan tinggi yang diminta, jadi jawabannya tidak bisa dipercaya. */
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
    // retries 1: failover lebih cepat daripada backoff bawaan near-api-js (12 percobaan).
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

  /** URL yang menjawab permintaan terakhir; nilai `indexer_cursor.rpc_endpoint`. */
  get activeEndpoint(): string {
    return this.#active.url;
  }

  async getFinalBlock(): Promise<RpcBlock> {
    return this.#withFailover((endpoint) => this.#readFinalBlock(endpoint));
  }

  /**
   * Blok final di tinggi `height`, atau `null` bila tinggi itu dilewati chain.
   * `null` hanya dikembalikan bila endpoint yang menjawab sudah final di atas `height`;
   * endpoint yang tertinggal dianggap gagal agar cursor tidak melompati blok.
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

  /** Operasi provider sembarang (mis. `chunk`, `tx`) dengan timeout dan failover yang sama. */
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

/** Buat klien dari `NEAR_RPC_PRIMARY_URL` dan `NEAR_RPC_FALLBACK_URL`; tidak ada URL bawaan. */
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
