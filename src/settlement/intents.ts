import { JsonRpcProvider } from "near-api-js";

export const INTENTS_CONTRACT = "intents.near";
export const USDT_TOKEN_ID = "usdt.tether-token.near";

/** Pemanggilan view NEAR; produksi memakai RPC, test memakai tiruan. */
export type ViewFunction = (contractId: string, method: string, args: Record<string, unknown>) => Promise<unknown>;

export function rpcViewFunction(rpcUrl: string): ViewFunction {
  const provider = new JsonRpcProvider({ url: rpcUrl }, { retries: 1 });
  return (contractId, method, args) =>
    provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });
}

export type SimulationResult = { ok: true; result: unknown } | { ok: false; code: "simulation_failed"; message: string };

/**
 * View `simulate_intents` di `intents.near`: tanpa dana, tanpa transaksi. Hasil sukses dikembalikan apa
 * adanya; error view dipetakan ke `simulation_failed` (kode internal, bukan HTTP).
 */
export async function simulateIntents(view: ViewFunction, signed: unknown[]): Promise<SimulationResult> {
  try {
    return { ok: true, result: await view(INTENTS_CONTRACT, "simulate_intents", { signed }) };
  } catch (error) {
    return { ok: false, code: "simulation_failed", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Panggilan kontrak yang ditandatangani pemilik di wallet; worker tidak memegang kunci. */
export interface ContractCall {
  contractId: string;
  methodName: string;
  args: Record<string, unknown>;
  /** 1 yoctoNEAR untuk method NEP-141/verifier yang mewajibkannya. */
  deposit: "1";
  gas?: string;
}

/**
 * `ft_withdraw` dari `intents.near` ke akun NEAR. Tanpa `msg`: `ft_withdraw` ber-`msg` ke
 * `x207-circle` tidak dipakai (ADR-19).
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

/** `msg` untuk `ft_on_transfer` `x207-circle` (Spec Antarmuka Kontrak bagian 3). */
export function stakeMsg(memberId?: string): string {
  return JSON.stringify({ action: "stake", ...(memberId ? { member_id: memberId } : {}) });
}

export function settleMsg(epoch: number, memberId?: string): string {
  return JSON.stringify({ action: "settle", epoch, ...(memberId ? { member_id: memberId } : {}) });
}

/** `ft_transfer_call` USDT ke `x207-circle` dengan `msg` stake atau settle. */
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
