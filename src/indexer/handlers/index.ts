import type { HandlerMap } from "./context.js";
import { bundleHandlers } from "./bundles.js";
import { grantHandlers } from "./grants.js";
import { intentHandlers } from "./intents.js";
import { epochHandlers } from "./epochs.js";
import { memberHandlers } from "./members.js";
import { paramsHandlers } from "./params.js";
import { riskHandlers } from "./risk.js";
import { settlementHandlers } from "./settlements.js";
import { voucherHandlers } from "./vouchers.js";

export type { Handler, HandlerContext, HandlerMap } from "./context.js";

/**
 * Handler per event. Event yang dikenal parser tetapi tidak ada di sini (mis. `clearing_submitted`,
 * `bundle_committed`) hanya disimpan di `events_raw` dengan `handled = 1` (Spec Skema D9 4).
 */
export const defaultHandlers: HandlerMap = {
  ...memberHandlers,
  ...voucherHandlers,
  ...epochHandlers,
  ...settlementHandlers,
  ...riskHandlers,
  ...paramsHandlers,
  ...bundleHandlers,
  ...grantHandlers,
  ...intentHandlers,
};
