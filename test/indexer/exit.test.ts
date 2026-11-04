import { afterEach, describe, expect, it } from "vitest";
import { fxServer } from "../helpers/fx-api.js";
import { acct, block, cutoffLog, eventLog } from "../helpers/fx-log42.js";

const BASE = "/x207/circles/agents-main";

// Extra blocks after FX-LOG42 (blocks 1000..1010).
const exitRequested = () => block(1011, { logs: [eventLog("exit_requested", { account_id: acct("translator"), epoch: 43 })] });
const withdrawn = () => block(1012, { logs: [eventLog("stake_withdrawn", { account_id: acct("translator"), amount: "100000000" })] });
const withdrawFailed = () => block(1013, { logs: [eventLog("stake_withdraw_failed", { account_id: acct("summarizer"), amount: "100000000" })] });
const reactivated = (h = 1014) => block(h, { logs: [eventLog("member_reactivated", { account_id: acct("scraper"), stake: "100000000", limit: "80000000", effective_epoch: 44 })] });

describe("BE-039 exit and reactivation handlers (ADR-29, ADR-30)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function setup(extra = [] as ReturnType<typeof block>[], upTo = 11) {
    const s = await fxServer(upTo, extra);
    close = s.close;
    const member = (name: string) => s.db.prepare("SELECT * FROM members WHERE account_id = ?").safeIntegers(true).get(acct(name)) as Record<string, unknown>;
    const get = async (path: string) => {
      const res = await fetch(`${s.srv.url}${BASE}${path}`);
      return { res, body: await res.json() };
    };
    return { s, member, get };
  }

  it("TC-BE-039-01 an exit request fills exit_requested_epoch without changing the status", async () => {
    const { member } = await setup([exitRequested()]);
    expect(member("translator")).toMatchObject({ exit_requested_epoch: 43n, status: "active" });
    expect(member("summarizer").exit_requested_epoch).toBeNull();
  });

  it("TC-BE-039-02 stake withdrawn: exited, stake 0", async () => {
    const { member } = await setup([exitRequested(), withdrawn()]);
    expect(member("translator")).toMatchObject({ status: "exited", stake: 0n, credit_limit: 0n, exit_requested_epoch: 43n });
  });

  it("TC-BE-039-03 a failed withdrawal is only recorded in events_raw", async () => {
    const { s, member } = await setup([withdrawFailed()]);
    const before = member("summarizer");
    expect(before).toMatchObject({ status: "active", stake: 100_000_000n });
    const raw = s.db.prepare("SELECT handled FROM events_raw WHERE event = 'stake_withdraw_failed'").all() as { handled: number }[];
    expect(raw).toEqual([{ handled: 1 }]);
  });

  it("TC-BE-039-04 reactivation stores the new stake and defers the status (K-36)", async () => {
    const { member } = await setup([reactivated(1011)]);
    expect(member("scraper")).toMatchObject({ stake: 100_000_000n, credit_limit: 80_000_000n, settled_history: 0n, reactivate_epoch: 44n, status: "suspended" });
  });

  it("TC-BE-039-13 reactivation takes effect when the effective epoch opens", async () => {
    const next = block(1012, { logs: [cutoffLog({ epoch: 43, next_epoch: 44, total_obligation: "0", edge_count: 0 })] });
    const { member } = await setup([reactivated(1011), next], 11);
    // epoch 43 has no obligations in FX-LOG42 yet, so cutoff 43 opens epoch 44 with edge 0
    expect(member("scraper").status).toBe("active");
  });

  it("TC-BE-039-06 outstanding_debt of a defaulted member uses the event value", async () => {
    const { member } = await setup();
    expect(member("scraper")).toMatchObject({ status: "suspended", outstanding_debt: 0n });
  });

  it("TC-BE-039-08 exitRequestedEpoch in the read API", async () => {
    const { get } = await setup([exitRequested()]);
    const t = await get(`/members/${acct("translator")}`);
    expect(t.body).toMatchObject({ exitRequestedEpoch: 43, status: "active" });
    const s = await get(`/members/${acct("summarizer")}`);
    expect(s.body.exitRequestedEpoch).toBeNull();
  });

  it("TC-BE-039-09 exited member in the read API", async () => {
    const { get } = await setup([exitRequested(), withdrawn()]);
    const { body } = await get("/members?status=exited");
    expect(body.items.map((m: { account: string }) => m.account)).toEqual([acct("translator")]);
    expect(body.items[0]).toMatchObject({ status: "exited", stake: "0" });
  });

  it("TC-BE-039-10 the 207 report still includes a member who requested exit if it has a position in that epoch", async () => {
    const { get } = await setup([exitRequested()]);
    const { res, body } = await get("/epochs/42");
    expect(res.status).toBe(207);
    const translator = body.members.find((m: { account: string }) => m.account === acct("translator"));
    expect(translator).toMatchObject({ status: 200, net: "0", settlement: null });
  });

  it("TC-BE-039-11 an exited member with no position in that epoch does not appear in the report", async () => {
    const { s, get } = await setup([exitRequested(), withdrawn()]);
    // epoch 44: committed, only gpu has a position (translator has no edge)
    s.db.prepare("INSERT INTO epochs (circle_id, epoch, phase, committed_at_ns, payment_deadline_ns, total_obligation, cleared_total) VALUES ('agents-main', 44, 'payment_window', 1, 2, 0, 0)").run();
    s.db.prepare("INSERT INTO settlements (circle_id, epoch, account_id, role, net, amount, status, updated_block) VALUES ('agents-main', 44, ?, 'creditor', 5, 5, 'claimable', 1)").run(acct("gpu"));
    const { body } = await get("/epochs/44");
    expect(body.members.map((m: { account: string }) => m.account)).toEqual([acct("gpu")]);
  });
});
