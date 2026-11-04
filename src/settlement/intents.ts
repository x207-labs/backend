import { JsonRpcProvider } from "near-api-js";

export const INTENTS_CONTRACT = "intents.near";
export const USDT_TOKEN_ID = "usdt.tether-token.near";

/** NEAR view call; production uses the RPC, tests use a fake. */
export type ViewFunction = (contractId: string, method: string, args: Record<string, unknown>) => Promise<unknown>;

export function rpcViewFunction(rpcUrl: string): ViewFunction {
  const provider = new JsonRpcProvider({ url: rpcUrl }, { retries: 1 });
  return (contractId, method, args) =>
    provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });
}

export type SimulationResult = { ok: true; result: unknown } | { ok: false; code: "simulation_failed"; message: string };

/**
 * `simulate_intents` view on `intents.near` (or the Verifier named by `verifier`, for near-sandbox): no funds, no transaction. A successful result is returned as
 * is; a view error is mapped to `simulation_failed` (internal code, not HTTP).
 */
export async function simulateIntents(view: ViewFunction, signed: unknown[], verifier: string = INTENTS_CONTRACT): Promise<SimulationResult> {
  try {
    return { ok: true, result: await view(verifier, "simulate_intents", { signed }) };
  } catch (error) {
    return { ok: false, code: "simulation_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Contract call signed by the owner in the wallet; the worker holds no keys. */
export interface ContractCall {
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  /** 1 yoctoNEAR for NEP-141/verifier methods that require it. */
  deposit: "1";
  gas?: string;
}

/**
 * `ft_withdraw` from `intents.near` to a NEAR account. Without `msg`: an `ft_withdraw` with `msg` to
 * `x207-circle` is not used (ADR-19).
 */
export function buildFtWithdraw(params: {
  token?: string;
  receiverId: string;
  amount: string;
  gas?: string;
}): ContractCall {
  return {
    contractId: INTENTS_CONTRACT,
    methodName: "ft_withdraw",
    args: { token: params.token ?? USDT_TOKEN_ID, receiver_id: params.receiverId, amount: params.amount },
    deposit: "1",
    ...(params.gas ? { gas: params.gas } : {}),
  };
}

/** `msg` for the `ft_on_transfer` of `x207-circle` (Spec Antarmuka Kontrak section 3). */
export function stakeMsg(memberId?: string): string {
  return JSON.stringify({ action: "stake", ...(memberId ? { member_id: memberId } : {}) });
}

export function settleMsg(epoch: number, memberId?: string): string {
  return JSON.stringify({ action: "settle", epoch, ...(memberId ? { member_id: memberId } : {}) });
}

/** `ft_transfer_call` of USDT to `x207-circle` with a stake or settle `msg`. */
export function buildFtTransferCall(params: {
  token?: string;
  receiverId: string;
  amount: string;
  msg: string;
  gas?: string;
}): ContractCall {
  return {
    contractId: params.token ?? USDT_TOKEN_ID,
    methodName: "ft_transfer_call",
    args: { receiver_id: params.receiverId, amount: params.amount, msg: params.msg },
    deposit: "1",
    ...(params.gas ? { gas: params.gas } : {}),
  };
}
