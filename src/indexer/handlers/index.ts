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
 * Handler per event. An event that the parser knows but that has no handler here (e.g. `clearing_submitted`,
 * `bundle_committed`) is only stored in `events_raw` with `handled = 1` (Spec Skema D9 4).
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
