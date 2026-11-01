/** Kode error read API (Spec API Backend 1.2). */
export type ApiErrorCode =
  | "invalid_request"
  | "circle_not_found"
  | "member_not_found"
  | "epoch_not_found"
  | "epoch_not_closed"
  | "job_not_found"
  | "one_click_error"
  | "not_found"
  | "rate_limited"
  | "indexer_unavailable";

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
