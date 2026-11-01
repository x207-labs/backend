/** Error settlement worker; kode dan status HTTP mengikuti Spec API Backend 1.2. */
export type SettlementErrorCode = "live_mode_disabled" | "asset_not_supported" | "one_click_error";

const STATUS: Record<SettlementErrorCode, number> = {
  live_mode_disabled: 422,
  asset_not_supported: 422,
  one_click_error: 502,
};

export class SettlementError extends Error {
  readonly status: number;

  constructor(
    readonly code: SettlementErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SettlementError";
    this.status = STATUS[code];
  }

  toBody(): { error: { code: SettlementErrorCode; message: string; details: Record<string, unknown> } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}
