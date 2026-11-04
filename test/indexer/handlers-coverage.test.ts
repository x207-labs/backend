import { describe, expect, it } from "vitest";
import { fxServer } from "../helpers/fx-api.js";
import { acct, block, claimFailedLog, eventLog } from "../helpers/fx-log42.js";

// Events emitted by contract 0.0.1 (spec sections 6 and 14); the 0.0.2 events are in TC-BE-013-03. One log fixture per event.
const CONTRACT_EVENTS = [
  "member_joined", "stake_added", "voucher_registered", "epoch_cutoff", "clearing_submitted", "clearing_applied",
  "epoch_committed", "residual_paid", "member_defaulted", "limits_updated", "epoch_finalized", "residual_claimed",
  "residual_claim_failed", "params_updated", "exit_requested", "stake_withdrawn", "stake_withdraw_failed",
] as const;

describe("BE-013 every indexer handler with a log fixture", () => {
  it("TC-BE-013-01 FX-LOG42 and the exit block touch every contract event, all handled", async () => {
    const extra = [
      block(1011, { logs: [eventLog("exit_requested", { account_id: acct("translator"), epoch: 43 })] }),
      block(1012, { logs: [eventLog("stake_withdraw_failed", { account_id: acct("translator"), amount: "100000000" })] }),
      block(1013, { logs: [eventLog("stake_withdrawn", { account_id: acct("translator"), amount: "100000000" })] }),
      block(1014, { logs: [claimFailedLog()] }),
    ];
    const { s, close } = await (async () => {
      const f = await fxServer(11, extra);
      return { s: f, close: f.close };
    })();
    try {
      const rows = s.db.prepare("SELECT event, handled FROM events_raw").all() as { event: string; handled: number }[];
      const seen = new Map<string, Set<number>>();
      for (const r of rows) seen.set(r.event, (seen.get(r.event) ?? new Set()).add(r.handled));
      for (const name of CONTRACT_EVENTS) {
        expect(seen.get(name), `${name} was never processed`).toEqual(new Set([1]));
      }
    } finally {
      await close();
    }
  });

  it("TC-BE-013-02 an unknown event is ignored without changing the read model and the lag is still recorded", async () => {
    const before = await fxServer(11);
    const members = before.db.prepare("SELECT account_id, stake, status FROM members ORDER BY account_id").all();
    await before.close();

    const unknown = block(1011, { logs: [eventLog("future_event", { account_id: acct("gpu"), anything: 1 })] });
    const after = await fxServer(11, [unknown]);
    try {
      const raw = after.db.prepare("SELECT handled FROM events_raw WHERE event = 'future_event'").all();
      expect(raw).toEqual([{ handled: 2 }]);
      expect(after.db.prepare("SELECT account_id, stake, status FROM members ORDER BY account_id").all()).toEqual(members);
      const cursor = after.db.prepare("SELECT last_block_height AS h FROM indexer_cursor").get() as { h: number };
      expect(cursor.h).toBe(1011);
    } finally {
      await after.close();
    }
  });

  it("TC-BE-013-03 interface 0.0.2 events reach a handler or events_raw, all handled", async () => {
    const extra = [
      block(1011, { logs: [eventLog("member_admitted", { account_id: acct("scraper"), status: "pending" })] }),
      block(1012, { logs: [eventLog("member_reactivated", { account_id: acct("scraper"), stake: "100000000", limit: "80000000", effective_epoch: 44 })] }),
      block(1013, { logs: [eventLog("solver_fee_claimed", { account_id: acct("gpu"), amount: "750000" })] }),
      block(1014, { logs: [eventLog("solver_fee_claim_failed", { account_id: acct("gpu"), amount: "750000" })] }),
    ];
    const f = await fxServer(11, extra);
    try {
      const rows = f.db.prepare("SELECT event, handled FROM events_raw WHERE block_height > 1010").all() as { event: string; handled: number }[];
      expect(rows.map((r) => r.event)).toEqual(["member_admitted", "member_reactivated", "solver_fee_claimed", "solver_fee_claim_failed"]);
      for (const r of rows) expect(r.handled, r.event).toBe(1);
      const scraper = f.db.prepare("SELECT admitted, reactivate_epoch FROM members WHERE account_id = ?").get(acct("scraper")) as { admitted: number; reactivate_epoch: number };
      expect(scraper).toEqual({ admitted: 1, reactivate_epoch: 44 });
    } finally {
      await f.close();
    }
  });
});
