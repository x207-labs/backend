import type Database from "better-sqlite3";
import type { OneClickClient } from "../one-click.js";
import { FINAL_STATUSES, getJob, listPollableJobs, updateJobStatus, type JobKind, type JobRow, type JobStatus } from "../jobs.js";

/**
 * Mapping of 1Click status to job status (Spec API Backend 6.5). `null` = no change
 * (deposit statuses do not apply to withdraw jobs).
 */
export function mapOneClickStatus(oneClickStatus: string, kind: JobKind): JobStatus | null {
  const deposit = kind !== "withdraw";
  switch (oneClickStatus) {
    case "PENDING_DEPOSIT":
    case "INCOMPLETE_DEPOSIT":
      return deposit ? "waiting_deposit" : null;
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return "processing";
    case "SUCCESS":
      return deposit ? "ready_withdraw" : "completed";
    case "REFUNDED":
      return "refunded";
    case "FAILED":
      return "failed";
    default:
      return null;
  }
}

export interface MonitorDeps {
  db: Database.Database;
  client: OneClickClient;
  now?: () => number;
}

function isPollable(job: JobRow): boolean {
  if (job.dry === 1 || job.deposit_address === null) return false;
  if (FINAL_STATUSES.includes(job.status)) return false;
  return job.kind === "withdraw" ? job.status === "processing" : job.status === "waiting_deposit" || job.status === "processing";
}

/**
 * Update one job from the 1Click status. A job that is final, has no deposit address yet, or is
 * `dry` is returned as is without calling 1Click. A 1Click error is thrown (`one_click_error`)
 * and the job in D9 does not change.
 */
export async function refreshJob(deps: MonitorDeps, job: JobRow): Promise<JobRow> {
  if (!isPollable(job)) return job;
  const now = (deps.now ?? Date.now)();
  const res = await deps.client.status(job.deposit_address as string);
  const raw = res.status as string;
  let next = mapOneClickStatus(raw, job.kind) ?? job.status;
  if (next === "waiting_deposit" && job.quote_deadline !== null && now > job.quote_deadline) next = "expired";
  if (next !== job.status || raw !== job.one_click_status) {
    updateJobStatus(deps.db, job.job_id, { status: next, one_click_status: raw, updated_at: now });
  }
  return getJob(deps.db, job.job_id) as JobRow;
}

/** One monitoring pass over all jobs that are still active; the failure of one job does not stop the others. */
export async function pollActiveJobs(deps: MonitorDeps): Promise<{ polled: number; failed: number }> {
  let failed = 0;
  const jobs = listPollableJobs(deps.db);
  for (const job of jobs) {
    try {
      await refreshJob(deps, job);
    } catch {
      failed += 1;
    }
  }
  return { polled: jobs.length, failed };
}

/** Run periodic monitoring; call the returned function to stop. */
export function startJobMonitor(deps: MonitorDeps, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    pollActiveJobs(deps).finally(() => {
      running = false;
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
