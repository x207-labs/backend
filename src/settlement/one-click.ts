import {
  ApiError,
  GenerateSwapTransferIntentRequest,
  OneClickService,
  OpenAPI,
  QuoteRequest,
  SubmitSwapTransferIntentRequest,
  type AppFee,
  type GenerateIntentResponse,
  type GetExecutionStatusResponse,
  type IntentStandardEnum,
  type MultiPayload,
  type QuoteResponse,
  type SubmitIntentResponse,
  type TokenResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import type { SettlementConfig, SettlementMode } from "./config.js";
import { SettlementError } from "./errors.js";
import { MockOneClickTransport } from "./mock-transport.js";

/** 1Click surface used by the worker; SDK 0.1.26 in production, a fake in tests. */
export interface OneClickTransport {
  getTokens(): Promise<TokenResponse[]>;
  getQuote(request: QuoteRequest): Promise<QuoteResponse>;
  getExecutionStatus(depositAddress: string, depositMemo?: string): Promise<GetExecutionStatusResponse>;
  generateIntent(request: GenerateSwapTransferIntentRequest): Promise<GenerateIntentResponse>;
  submitIntent(request: SubmitSwapTransferIntentRequest): Promise<SubmitIntentResponse>;
}

const USER_AGENT = "x207-backend/0.0.1";

/**
 * SDK-based transport. The SDK uses the global `OpenAPI` configuration, so one process has one configuration.
 * The `User-Agent` header is required: without it 1Click answers `error code: 1010` (Runbook section 8).
 */
export function sdkTransport(options: { baseUrl: string; jwt: string | undefined }): OneClickTransport {
  OpenAPI.BASE = options.baseUrl;
  OpenAPI.TOKEN = options.jwt;
  OpenAPI.HEADERS = { "User-Agent": USER_AGENT };
  return {
    getTokens: () => OneClickService.getTokens(),
    getQuote: (r) => OneClickService.getQuote(r),
    getExecutionStatus: (a, m) => OneClickService.getExecutionStatus(a, m),
    generateIntent: (r) => OneClickService.generateIntent(r),
    submitIntent: (r) => OneClickService.submitIntent(r),
  };
}

export interface QuoteParams {
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  originAsset: string;
  destinationAsset: string;
  /** Smallest unit of the asset determined by `swapType`. */
  amount: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  recipientType: "INTENTS" | "DESTINATION_CHAIN";
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  refundTo: string;
  recipient: string;
  /** Basis points; default 100 (1%). */
  slippageTolerance?: number;
  /** ISO 8601; default now + `quoteValidityMs`. */
  deadline?: string;
  /** Default `true`. `false` is accepted only in `live` mode. */
  dry?: boolean;
}

export interface OneClickClientOptions {
  config: SettlementConfig;
  /** Replaces the default transport (tests). Ignored in `mock` mode. */
  transport?: OneClickTransport;
  now?: () => number;
  /** Validity of the quote `deadline` when not given. */
  quoteValidityMs?: number;
  /** How long the `/v0/tokens` list is cached. */
  tokensTtlMs?: number;
}

const DEFAULT_QUOTE_VALIDITY_MS = 30 * 60_000;
const DEFAULT_TOKENS_TTL_MS = 10 * 60_000;

export class OneClickClient {
  readonly mode: SettlementMode;
  readonly #transport: OneClickTransport;
  readonly #appFees: AppFee[];
  readonly #now: () => number;
  readonly #quoteValidityMs: number;
  readonly #tokensTtlMs: number;
  #tokens: { at: number; ids: Set<string>; list: TokenResponse[] } | null = null;

  constructor(options: OneClickClientOptions) {
    const { config } = options;
    this.mode = config.mode;
    this.#transport =
      config.mode === "mock"
        ? new MockOneClickTransport()
        : (options.transport ?? sdkTransport({ baseUrl: config.baseUrl, jwt: config.jwt }));
    this.#appFees = config.appFees;
    this.#now = options.now ?? Date.now;
    this.#quoteValidityMs = options.quoteValidityMs ?? DEFAULT_QUOTE_VALIDITY_MS;
    this.#tokensTtlMs = options.tokensTtlMs ?? DEFAULT_TOKENS_TTL_MS;
  }

  /** Assets supported by 1Click (`/v0/tokens`, Supported Assets). */
  async listTokens(): Promise<TokenResponse[]> {
    const t = this.#now();
    if (!this.#tokens || t - this.#tokens.at >= this.#tokensTtlMs) {
      const list = await this.#call(() => this.#transport.getTokens());
      this.#tokens = { at: t, ids: new Set(list.map((x) => x.assetId)), list };
    }
    return this.#tokens.list;
  }

  async assertSupported(assetId: string): Promise<void> {
    await this.listTokens();
    if (!this.#tokens?.ids.has(assetId)) {
      throw new SettlementError("asset_not_supported", `Asset ${assetId} is not in the 1Click list`, { asset: assetId });
    }
  }

  /**
   * 1Click quote. `dry` defaults to `true`; `dry: false` only in `live` mode, otherwise it is rejected with
   * `live_mode_disabled` before any request. `dry` mode always sends `dry: true`.
   */
  async quote(params: QuoteParams): Promise<QuoteResponse> {
    const wantsLive = params.dry === false;
    if (wantsLive && this.mode !== "live") {
      throw new SettlementError("live_mode_disabled", "dry: false needs X207_SETTLEMENT_MODE=live", { mode: this.mode });
    }
    await this.assertSupported(params.originAsset);
    await this.assertSupported(params.destinationAsset);

    const request: QuoteRequest = {
      dry: !wantsLive,
      swapType: QuoteRequest.swapType[params.swapType],
      slippageTolerance: params.slippageTolerance ?? 100,
      originAsset: params.originAsset,
      depositType: QuoteRequest.depositType[params.depositType],
      destinationAsset: params.destinationAsset,
      amount: params.amount,
      refundTo: params.refundTo,
      refundType: QuoteRequest.refundType[params.refundType],
      recipient: params.recipient,
      recipientType: QuoteRequest.recipientType[params.recipientType],
      deadline: params.deadline ?? new Date(this.#now() + this.#quoteValidityMs).toISOString(),
      ...(this.#appFees.length > 0 ? { appFees: this.#appFees } : {}),
    };
    return this.#call(() => this.#transport.getQuote(request));
  }

  status(depositAddress: string, depositMemo?: string): Promise<GetExecutionStatusResponse> {
    return this.#call(() => this.#transport.getExecutionStatus(depositAddress, depositMemo));
  }

  /** Unsigned intent for a `depositAddress` quote; signed by the creditor's wallet. */
  generateIntent(params: {
    depositAddress: string;
    signerId: string;
    standard: IntentStandardEnum;
  }): Promise<GenerateIntentResponse> {
    return this.#call(() =>
      this.#transport.generateIntent({ type: GenerateSwapTransferIntentRequest.type.SWAP_TRANSFER, ...params }),
    );
  }

  submitIntent(signedData: MultiPayload): Promise<SubmitIntentResponse> {
    return this.#call(() =>
      this.#transport.submitIntent({ type: SubmitSwapTransferIntentRequest.type.SWAP_TRANSFER, signedData }),
    );
  }

  async #call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SettlementError) throw error;
      throw toOneClickError(error);
    }
  }
}

function toOneClickError(error: unknown): SettlementError {
  if (error instanceof ApiError) {
    const body = error.body as { message?: unknown } | string | undefined;
    const upstream = typeof body === "string" ? body : typeof body?.message === "string" ? body.message : error.statusText;
    return new SettlementError("one_click_error", `1Click rejected the request: ${upstream}`, {
      upstream,
      upstreamStatus: error.status,
    });
  }
  const upstream = error instanceof Error ? error.message : String(error);
  return new SettlementError("one_click_error", `1Click unreachable: ${upstream}`, { upstream });
}
