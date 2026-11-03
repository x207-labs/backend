import { buildFtTransferCall, buildFtWithdraw, settleMsg, stakeMsg, type ContractCall } from "../intents.js";
import type { JobRow } from "../jobs.js";

/**
 * Dua panggilan yang menyelesaikan jalur masuk setelah job berstatus `ready_withdraw` (ADR-19): `ft_withdraw`
 * dari `intents.near` ke akun NEAR pemilik tanpa `msg`, lalu `ft_transfer_call` USDT ke kontrak lingkaran dengan
 * `msg` stake atau settle. Worker tidak menandatangani; wallet atau skrip demo yang mengirimnya.
 *
 * `owner` adalah akun NEAR yang memegang USDT dan menandatangani; bila berbeda dari anggota, `member_id`
 * disertakan di `msg`.
 */
export function buildDepositSteps(params: {
  job: Pick<JobRow, "kind" | "status" | "account_id" | "epoch" | "amount_out">;
  owner: string;
  circleContractId: string;
}): [ContractCall, ContractCall] {
  const { job, owner, circleContractId } = params;
  if (job.kind === "withdraw") throw new Error("withdraw job has no deposit-path steps");
  if (job.status !== "ready_withdraw") throw new Error(`job is ${job.status}; the steps of the deposit path need ready_withdraw`);
  if (job.amount_out === null) throw new Error("job without amount_out");
  const memberId = owner === job.account_id ? undefined : job.account_id;
  let msg: string;
  if (job.kind === "deposit_stake") {
    msg = stakeMsg(memberId);
  } else {
    if (job.epoch === null) throw new Error("settle job without epoch");
    msg = settleMsg(job.epoch, memberId);
  }
  return [
    buildFtWithdraw({ receiverId: owner, amount: job.amount_out }),
    buildFtTransferCall({ receiverId: circleContractId, amount: job.amount_out, msg }),
  ];
}
