import { describe, expect, it } from "vitest";
import { fxServer } from "../helpers/fx-api.js";
import { acct, block, claimFailedLog, eventLog } from "../helpers/fx-log42.js";

// Event yang dipancarkan kontrak 0.0.1 (spec bagian 6 dan 14). Satu fixture log untuk tiap event.
const CONTRACT_EVENTS = [
  "member_joined", "stake_added", "voucher_registered", "epoch_cutoff", "clearing_submitted", "clearing_applied",
  "epoch_committed", "residual_paid", "member_defaulted", "limits_updated", "epoch_finalized", "residual_claimed",
  "residual_claim_failed", "params_updated", "exit_requested", "stake_withdrawn", "stake_withdraw_failed",
] as const;

describe("BE-013 setiap handler indexer dengan fixture log", () => {
  it("TC-BE-013-01 FX-LOG42 dan blok keluar menyentuh setiap event kontrak, semuanya handled", async () => {
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
        expect(seen.get(name), `${name} tidak pernah diproses`).toEqual(new Set([1]));
      }
    } finally {
      await close();
    }
  });

  it("TC-BE-013-02 event tak dikenal diabaikan tanpa mengubah read model dan lag tetap tercatat", async () => {
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
});
