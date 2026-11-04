import {
  GetExecutionStatusResponse,
  QuoteRequest,
  type GenerateIntentResponse,
  type QuoteResponse,
  type SubmitIntentResponse,
  type TokenResponse,
} from "@defuse-protocol/one-click-sdk-typescript";
import type { OneClickTransport } from "./one-click.js";

export const USDT_NEAR = "nep141:usdt.tether-token.near";
export const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const USDT_TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";

/** Mock `/v0/tokens` (FX-1C): USDT NEAR, USDC Base, USDT Tron. */
export const MOCK_TOKENS = [
  { assetId: USDT_NEAR, decimals: 6, blockchain: "near", symbol: "USDT", price: 1 },
  { assetId: USDC_BASE, decimals: 6, blockchain: "base", symbol: "USDC", price: 1 },
  { assetId: USDT_TRON, decimals: 6, blockchain: "tron", symbol: "USDT", price: 1 },
] as unknown as TokenResponse[];

/** Round 3 recording B2.1–B2.5: nominal USDT Intents → USDC Base (`withdrawFee` fixed at 2400). */
const B2_AMOUNT_OUT: Record<string, string> = {
  "10000": "7582",
  "100000": "97450",
  "250000": "247239",
  "1000000": "996203",
  "5000000": "4990613",
};
const BASE_WITHDRAW_FEE = 2400n;
const TRON_WITHDRAW_FEE = 900000n;
/** B1.4: 1 USDC Base → 1.001078 USDT Intents. */
const B14_NUM = 1001078n;
const B14_DEN = 1000000n;

interface Priced {
  amountIn: bigint;
  amountOut: bigint;
  withdrawFee: bigint;
}

function price(req: QuoteRequest): Priced {
  const amount = BigInt(req.amount);
  const toIntents = req.recipientType === QuoteRequest.recipientType.INTENTS;
  if (toIntents && req.originAsset === USDT_NEAR) {
    // B1.1: USDT NEAR → USDT Intents 1:1, no fee
    return { amountIn: amount, amountOut: amount, withdrawFee: 0n };
  }
  if (toIntents) {
    // B1.4: origin on another chain → USDT Intents; EXACT_OUTPUT: amount = USDT that arrives
    if (req.swapType === QuoteRequest.swapType.EXACT_OUTPUT) {
      return { amountIn: (amount * B14_DEN) / B14_NUM + 1n, amountOut: amount, withdrawFee: 0n };
    }
    return { amountIn: amount, amountOut: (amount * B14_NUM) / B14_DEN, withdrawFee: 0n };
  }
  const fee = req.destinationAsset === USDT_TRON ? TRON_WITHDRAW_FEE : BASE_WITHDRAW_FEE;
  const recorded = B2_AMOUNT_OUT[req.amount];
  if (recorded !== undefined && fee === BASE_WITHDRAW_FEE) {
    return { amountIn: amount, amountOut: BigInt(recorded), withdrawFee: fee };
  }
  // outside the recording: fixed fee plus ~14 bps variable cost (BE-002)
  const net = amount > fee ? amount - fee : 0n;
  return { amountIn: amount, amountOut: net - (net * 14n) / 10000n, withdrawFee: fee };
}

/** 1Click transport with no network. Deterministic answers from the Round 3 spike recording. */
export class MockOneClickTransport implements OneClickTransport {
  readonly requests: string[] = [];

  async getTokens(): Promise<TokenResponse[]> {
    this.requests.push("tokens");
    return MOCK_TOKENS;
  }

  async getQuote(req: QuoteRequest): Promise<QuoteResponse> {
    this.requests.push("quote");
    const { amountIn, amountOut, withdrawFee } = price(req);
    const quote = {
      ...(req.dry ? {} : { depositAddress: "mock-deposit-address", deadline: req.deadline }),
      amountIn: amountIn.toString(),
      amountInFormatted: "",
      amountInUsd: "",
      minAmountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
      amountOutFormatted: "",
      amountOutUsd: "",
      minAmountOut: ((amountOut * 99n) / 100n).toString(),
      timeEstimate: 20,
      withdrawFee: withdrawFee.toString(),
    };
    return {
      correlationId: "mock",
      timestamp: new Date(0).toISOString(),
      signature: "mock",
      quoteRequest: req,
      quote,
    } as unknown as QuoteResponse;
  }

  async getExecutionStatus(depositAddress: string): Promise<GetExecutionStatusResponse> {
    this.requests.push("status");
    return {
      correlationId: "mock",
      quoteResponse: { quote: { depositAddress } },
      status: GetExecutionStatusResponse.status.SUCCESS,
      updatedAt: new Date(0).toISOString(),
      swapDetails: {},
    } as unknown as GetExecutionStatusResponse;
  }

  async generateIntent(): Promise<GenerateIntentResponse> {
    this.requests.push("generate-intent");
    return { intent: { standard: "nep413", mock: true }, correlationId: "mock" } as unknown as GenerateIntentResponse;
  }

  async submitIntent(): Promise<SubmitIntentResponse> {
    this.requests.push("submit-intent");
    return { intentHash: "mock-intent-hash", correlationId: "mock" };
  }
}
