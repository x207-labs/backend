import type { BlockLog, BlockSource, SourceBlock } from "./block-source.js";

export interface NeardataSourceOptions {
  /** E.g. `https://mainnet.neardata.xyz`; no default value in the code. */
  baseUrl: string;
  contractId: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface NeardataOutcome {
  execution_outcome: { id: string; outcome: { executor_id: string; logs: string[] } };
  tx_hash: string | null;
  /** The receipt as the streamer shows it; only the parts that name the signer and the method are read, and every one of them may be missing. */
  receipt?: { receipt?: { Action?: { signer_id?: string; actions?: Array<{ FunctionCall?: { method_name?: string } }> } } };
}

interface NeardataBlock {
  block: { header: { height: number; hash: string; timestamp_nanosec: string } };
  shards: { receipt_execution_outcomes?: NeardataOutcome[] }[];
}

/** Neardata response for a block that does not exist yet. */
const FUTURE_BLOCK = "BLOCK_DOES_NOT_EXIST";

export class NeardataError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "NeardataError";
  }
}

/** Mainnet: `GET /v0/block/{height}` contains the outcome receipts of all shards in one response. */
export class NeardataBlockSource implements BlockSource {
  readonly endpoint: string;
  readonly #contractId: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: NeardataSourceOptions) {
    this.endpoint = options.baseUrl.replace(/\/+$/, "");
    this.#contractId = options.contractId;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? fetch;
  }

  async finalHeight(): Promise<number> {
    const body = (await this.#get("/v0/last_block/final")) as NeardataBlock | null;
    if (!body) throw new NeardataError("last_block/final returned null");
    return body.block.header.height;
  }

  async getBlock(height: number): Promise<SourceBlock | null> {
    const body = (await this.#get(`/v0/block/${height}`)) as NeardataBlock | null;
    if (body === null) return null;
    const { header } = body.block;
    const logs: BlockLog[] = [];
    for (const shard of body.shards) {
      for (const item of shard.receipt_execution_outcomes ?? []) {
        const { id, outcome } = item.execution_outcome;
        if (outcome.executor_id !== this.#contractId) continue;
        const action = item.receipt?.receipt?.Action;
        const signerId = action?.signer_id ?? null;
        const methodName = action?.actions?.find((a) => a.FunctionCall !== undefined)?.FunctionCall?.method_name ?? null;
        outcome.logs.forEach((log, logIndex) => {
          logs.push({ receiptId: id, logIndex, executorId: outcome.executor_id, txHash: item.tx_hash ?? null, ...(signerId === null ? {} : { signerId }), ...(methodName === null ? {} : { methodName }), log });
        });
      }
    }
    return { height: header.height, hash: header.hash, timestampNs: BigInt(header.timestamp_nanosec), logs };
  }

  async #get(path: string): Promise<unknown> {
    const response = await this.#fetch(`${this.endpoint}${path}`, { signal: AbortSignal.timeout(this.#timeoutMs) });
    const text = await response.text();
    if (!response.ok) {
      throw new NeardataError(`${path}: HTTP ${response.status} ${text.slice(0, 200)}`, response.status);
    }
    const body: unknown = JSON.parse(text);
    if (body !== null && typeof body === "object" && "type" in body && body.type === FUTURE_BLOCK) {
      throw new NeardataError(`${path}: ${FUTURE_BLOCK}`);
    }
    return body;
  }
}
