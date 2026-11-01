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
  if (job.kind === "withdraw") throw new Error("job withdraw tidak punya langkah jalur masuk");
  if (job.status !== "ready_withdraw") throw new Error(`job berstatus ${job.status}, langkah jalur masuk butuh ready_withdraw`);
  if (job.amount_out === null) throw new Error("job tanpa amount_out");
  const memberId = owner === job.account_id ? undefined : job.account_id;
  let msg: string;
  if (job.kind === "deposit_stake") {
    msg = stakeMsg(memberId);
  } else {
    if (job.epoch === null) throw new Error("job settle tanpa epoch");
    msg = settleMsg(job.epoch, memberId);
  }
  return [
    buildFtWithdraw({ receiverId: owner, amount: job.amount_out }),
    buildFtTransferCall({ receiverId: circleContractId, amount: job.amount_out, msg }),
  ];
}
