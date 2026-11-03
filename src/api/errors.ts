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
  | "grant_not_found"
  | "scope_invalid"
  | "delivery_not_found"
  | "delivery_state"
  | "not_a_party"
  | "offer_not_found"
  | "offer_not_open"
  | "negotiation_closed"
  | "epoch_not_open"
  | "proposal_not_found"
  | "referral_not_found"
  | "referral_refused"
  | "referral_not_open"
  | "deal_not_found"
  | InvoiceApiErrorCode
  | OrderApiErrorCode
  | PurchaseApiErrorCode;

/** BE-051: codes of 5e; the `InvoiceError` codes of `@x207/core` are passed on as they are. */
export type InvoiceApiErrorCode =
  | "invoice_duplicate" | "invoice_not_found" | "invoice_not_party" | "invoice_bad_state" | "installment_voucher_mismatch"
  | "invoice_bad_id" | "invoice_bad_account" | "invoice_same_party" | "invoice_bad_amount" | "invoice_bad_memo" | "invoice_bad_resource"
  | "installment_count" | "installment_amount_too_small" | "installment_bad_epoch" | "installment_not_found" | "installment_already_shifted" | "installment_bad_state";
/** BE-054 and BE-055: codes of 5f; the `OrderError` codes of `@x207/core` are passed on as they are. */
export type OrderApiErrorCode =
  | "order_not_found" | "order_not_party" | "order_bad_state" | "order_duplicate" | "milestone_not_found" | "sample_required" | "target_required" | "target_unverified" | "target_forbidden"
  | "order_bad_kind" | "order_bad_account" | "order_same_party" | "order_bad_hash" | "order_sample_required" | "order_target_required" | "order_target_forbidden" | "order_bad_target"
  | "order_bad_milestones" | "order_bad_amount" | "order_bad_proof" | "order_bad_nonce" | "order_bad_resource" | "order_not_proof_kind"
  | "order_mandate_required" | "order_mandate_forbidden" | "order_bad_mandate" | "claim_invalid" | "claim_rpc_unavailable" | "payload_too_large" | "open_limit_reached"
  | "code_bad_account" | "code_bad_commitment" | "code_bad_salt" | "code_bad_value" | "code_bad_code" | "code_bad_nonce" | "code_bad_resource" | "code_bad_arbiter" | "code_bad_limit" | "code_over_limit_unbonded"
  | "code_not_checked" | "code_used" | "code_unknown" | "code_issuer_unknown" | "code_issuer_unavailable" | "code_bound_to_identity" | "code_not_verifiable";
/** BE-056: codes of 5g. */
export type PurchaseApiErrorCode =
  | "purchase_not_found" | "purchase_not_party" | "purchase_bad_state" | "proof_invalid" | "exclusive_taken" | "license_id_rejected" | "preview_contains_pii" | "source_forbidden" | "takedown_invalid";

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
