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

/** Permukaan 1Click yang dipakai worker; SDK 0.1.26 di produksi, tiruan di test. */
export interface OneClickTransport {
  getTokens(): Promise<TokenResponse[]>;
  getQuote(request: QuoteRequest): Promise<QuoteResponse>;
  getExecutionStatus(depositAddress: string, depositMemo?: string): Promise<GetExecutionStatusResponse>;
  generateIntent(request: GenerateSwapTransferIntentRequest): Promise<GenerateIntentResponse>;
  submitIntent(request: SubmitSwapTransferIntentRequest): Promise<SubmitIntentResponse>;
}

const USER_AGENT = "x207-backend/0.0.1";

/**
 * Transport berbasis SDK. SDK memakai konfigurasi global `OpenAPI`, jadi satu proses satu konfigurasi.
 * Header `User-Agent` wajib: tanpa itu 1Click menjawab `error code: 1010` (Runbook bagian 8).
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
  /** Satuan terkecil aset yang ditentukan `swapType`. */
  amount: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  recipientType: "INTENTS" | "DESTINATION_CHAIN";
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  refundTo: string;
  recipient: string;
  /** Basis poin; default 100 (1%). */
  slippageTolerance?: number;
  /** ISO 8601; default sekarang + `quoteValidityMs`. */
  deadline?: string;
  /** Default `true`. `false` hanya diterima di mode `live`. */
  dry?: boolean;
}

export interface OneClickClientOptions {
  config: SettlementConfig;
  /** Menggantikan transport bawaan (test). Diabaikan di mode `mock`. */
  transport?: OneClickTransport;
  now?: () => number;
  /** Masa berlaku `deadline` quote bila tidak diberikan. */
  quoteValidityMs?: number;
  /** Lama daftar `/v0/tokens` di-cache. */
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

  /** Aset yang didukung 1Click (`/v0/tokens`, Supported Assets). */
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
      throw new SettlementError("asset_not_supported", `Aset ${assetId} tidak ada di daftar 1Click`, { asset: assetId });
    }
  }

  /**
   * Quote 1Click. `dry` default `true`; `dry: false` hanya di mode `live`, selain itu ditolak
   * `live_mode_disabled` sebelum ada request. Mode `dry` selalu mengirim `dry: true`.
   */
  async quote(params: QuoteParams): Promise<QuoteResponse> {
    const wantsLive = params.dry === false;
    if (wantsLive && this.mode !== "live") {
      throw new SettlementError("live_mode_disabled", "dry: false butuh X207_SETTLEMENT_MODE=live", { mode: this.mode });
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

  /** Intent belum bertanda tangan untuk quote `depositAddress`; ditandatangani wallet kreditor. */
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
    return new SettlementError("one_click_error", `1Click menolak permintaan: ${upstream}`, {
      upstream,
      upstreamStatus: error.status,
    });
  }
  const upstream = error instanceof Error ? error.message : String(error);
  return new SettlementError("one_click_error", `1Click tidak terjangkau: ${upstream}`, { upstream });
}
