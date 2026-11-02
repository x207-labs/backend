/** Kode error read API (Spec API Backend 1.2). */
export type ApiErrorCode =
  | "invalid_request"
  | "circle_not_found"
  | "member_not_found"
  | "epoch_not_found"
  | "epoch_not_closed"
  | "job_not_found"
  | "nothing_due"
  | "refund_account_not_found"
  | "asset_not_supported"
  | "live_mode_disabled"
  | "one_click_error"
  | "dao_unavailable"
  | "job_state_conflict"
  | "below_withdraw_threshold"
  | "high_fee_requires_ack"
  | "not_found"
  | "rate_limited"
  | "indexer_unavailable"
  | "invalid_signature"
  | "member_not_active"
  | "already_exists"
  | "listing_not_found"
  | "listing_not_open"
  | "asset_class_rejected"
  | "offer_not_found"
  | "offer_not_open"
  | "negotiation_closed"
  | "epoch_not_open"
  | "proposal_not_found"
  | "referral_not_found"
  | "referral_refused"
  | "referral_not_open";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  toBody(): { error: { code: ApiErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const invalidRequest = (message: string, details: Record<string, unknown> = {}) =>
  new ApiError(400, "invalid_request", message, details);
