import type { BlockLog, BlockPrune, BlockSource, SourceBlock } from "./block-source.js";

export interface NeardataSourceOptions {
  /** E.g. `https://mainnet.neardata.xyz`; no default value in the code. */
  baseUrl: string;
  contractId: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface NeardataOutcome {
  execution_outcome: { id: string; outcome: { executor_id: string; logs: string[]; status?: Record<string, unknown> | string } };
  tx_hash: string | null;
  /** The receipt as the streamer shows it; only the parts that name the signer and the method are read, and every one of them may be missing. */
  receipt?: { receipt?: { Action?: { signer_id?: string; actions?: Array<{ FunctionCall?: { method_name?: string; args?: string } }> } } };
}

interface NeardataBlock {
  block: { header: { height: number; hash: string; timestamp_nanosec: string } };
  shards: { receipt_execution_outcomes?: NeardataOutcome[] }[];
}

/** `epoch` of the JSON arguments (base64) of a `prune_epoch` call, or null when they do not say one. */
function pruneEpochOf(args: string | undefined): number | null {
  if (typeof args !== "string") return null;
  try {
    const epoch = (JSON.parse(Buffer.from(args, "base64").toString("utf8")) as { epoch?: unknown }).epoch;
    return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 1 ? epoch : null;
  } catch {
    return null;
  }
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
    const prunes: BlockPrune[] = [];
    for (const shard of body.shards) {
      for (const item of shard.receipt_execution_outcomes ?? []) {
        const { id, outcome } = item.execution_outcome;
        if (outcome.executor_id !== this.#contractId) continue;
        // A-BE-01: a failed receipt keeps the logs it wrote before the panic but its state change was rolled back; an event of it never happened
        if (typeof outcome.status === "object" && outcome.status !== null && "Failure" in outcome.status) continue;
        const action = item.receipt?.receipt?.Action;
        const signerId = action?.signer_id ?? null;
        const methodName = action?.actions?.find((a) => a.FunctionCall !== undefined)?.FunctionCall?.method_name ?? null;
        // BE-091: `prune_epoch` emits nothing; a call that succeeded is the only sign that the pairs of the epoch are gone
        for (const a of action?.actions ?? []) {
          const call = a.FunctionCall;
          const status = outcome.status;
          const succeeded = typeof status === "object" && status !== null && "SuccessValue" in status;
          if (call?.method_name !== "prune_epoch" || !succeeded) continue;
          const epoch = pruneEpochOf(call.args);
          if (epoch !== null) prunes.push({ receiptId: id, txHash: item.tx_hash ?? null, ...(signerId === null ? {} : { signerId }), epoch });
        }
        outcome.logs.forEach((log, logIndex) => {
          logs.push({ receiptId: id, logIndex, executorId: outcome.executor_id, txHash: item.tx_hash ?? null, ...(signerId === null ? {} : { signerId }), ...(methodName === null ? {} : { methodName }), log });
        });
      }
    }
    return { height: header.height, hash: header.hash, timestampNs: BigInt(header.timestamp_nanosec), logs, ...(prunes.length === 0 ? {} : { prunes }) };
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
