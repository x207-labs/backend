import type Database from "better-sqlite3";

export type JobKind = "deposit_stake" | "deposit_settle" | "withdraw";
export type JobStatus =
  | "quoted"
  | "awaiting_signature"
  | "waiting_deposit"
  | "processing"
  | "ready_withdraw"
  | "completed"
  | "failed"
  | "expired"
  | "refunded";

/** Baris `settlement_jobs` (Spec Skema D9 3.9). Jumlah 1Click tetap string. */
export interface JobRow {
  job_id: string;
  kind: JobKind;
  circle_id: string;
  account_id: string;
  epoch: number | null;
  origin_asset: string;
  destination_asset: string;
  amount_in: string | null;
  amount_out: string | null;
  withdraw_fee: string | null;
  deposit_address: string | null;
  refund_to: string;
  recipient: string;
  recipient_type: "INTENTS" | "DESTINATION_CHAIN";
  dry: number;
  one_click_status: string | null;
  status: JobStatus;
  quote_json: string;
  intent_hash: string | null;
  quote_deadline: number | null;
  created_at: number;
  updated_at: number;
}

/** Status akhir: tidak ada langkah lanjut dan tidak dipantau lagi. */
export const FINAL_STATUSES: readonly JobStatus[] = ["ready_withdraw", "completed", "failed", "expired", "refunded"];

export type NewJob = Omit<JobRow, "one_click_status" | "intent_hash" | "updated_at"> &
  Partial<Pick<JobRow, "one_click_status" | "intent_hash" | "updated_at">>;

export function insertJob(db: Database.Database, job: NewJob): void {
  const row = { one_click_status: null, intent_hash: null, updated_at: job.created_at, ...job };
  db.prepare(
    `INSERT INTO settlement_jobs
     (job_id, kind, circle_id, account_id, epoch, origin_asset, destination_asset, amount_in, amount_out, withdraw_fee,
      deposit_address, refund_to, recipient, recipient_type, dry, one_click_status, status, quote_json, intent_hash,
      quote_deadline, created_at, updated_at)
     VALUES (@job_id, @kind, @circle_id, @account_id, @epoch, @origin_asset, @destination_asset, @amount_in, @amount_out,
      @withdraw_fee, @deposit_address, @refund_to, @recipient, @recipient_type, @dry, @one_click_status, @status,
      @quote_json, @intent_hash, @quote_deadline, @created_at, @updated_at)`,
  ).run(row);
}

export function getJob(db: Database.Database, jobId: string): JobRow | undefined {
  return db.prepare("SELECT * FROM settlement_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
}

/** Job yang masih menunggu 1Click: deposit `waiting_deposit`/`processing`, withdraw `processing`. */
export function listPollableJobs(db: Database.Database): JobRow[] {
  return db
    .prepare(
      `SELECT * FROM settlement_jobs
       WHERE dry = 0 AND deposit_address IS NOT NULL
         AND ((kind IN ('deposit_stake','deposit_settle') AND status IN ('waiting_deposit','processing'))
           OR (kind = 'withdraw' AND status = 'processing'))
       ORDER BY created_at`,
    )
    .all() as JobRow[];
}

export function updateJobStatus(
  db: Database.Database,
  jobId: string,
  patch: { status: JobStatus; one_click_status: string | null; updated_at: number },
): void {
  db.prepare(
    "UPDATE settlement_jobs SET status = @status, one_click_status = @one_click_status, updated_at = @updated_at WHERE job_id = @job_id",
  ).run({ ...patch, job_id: jobId });
}
