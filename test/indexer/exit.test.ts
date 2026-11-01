import { afterEach, describe, expect, it } from "vitest";
import { fxServer } from "../helpers/fx-api.js";
import { acct, block, cutoffLog, eventLog } from "../helpers/fx-log42.js";

const BASE = "/x207/circles/agents-main";

// Blok tambahan setelah FX-LOG42 (blok 1000..1010).
const exitRequested = () => block(1011, { logs: [eventLog("exit_requested", { account_id: acct("translator"), epoch: 43 })] });
const withdrawn = () => block(1012, { logs: [eventLog("stake_withdrawn", { account_id: acct("translator"), amount: "100000000" })] });
const withdrawFailed = () => block(1013, { logs: [eventLog("stake_withdraw_failed", { account_id: acct("summarizer"), amount: "100000000" })] });
const reactivated = (h = 1014) => block(h, { logs: [eventLog("member_reactivated", { account_id: acct("scraper"), stake: "100000000", limit: "80000000", effective_epoch: 44 })] });

describe("BE-039 handler jalan keluar dan reaktivasi (ADR-29, ADR-30)", () => {
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

  it("TC-BE-039-01 permintaan keluar mengisi exit_requested_epoch tanpa mengubah status", async () => {
    const { member } = await setup([exitRequested()]);
    expect(member("translator")).toMatchObject({ exit_requested_epoch: 43n, status: "active" });
    expect(member("summarizer").exit_requested_epoch).toBeNull();
  });

  it("TC-BE-039-02 stake ditarik: exited, stake 0", async () => {
    const { member } = await setup([exitRequested(), withdrawn()]);
    expect(member("translator")).toMatchObject({ status: "exited", stake: 0n, credit_limit: 0n, exit_requested_epoch: 43n });
  });

  it("TC-BE-039-03 penarikan gagal hanya tercatat di events_raw", async () => {
    const { s, member } = await setup([withdrawFailed()]);
    const before = member("summarizer");
    expect(before).toMatchObject({ status: "active", stake: 100_000_000n });
    const raw = s.db.prepare("SELECT handled FROM events_raw WHERE event = 'stake_withdraw_failed'").all() as { handled: number }[];
    expect(raw).toEqual([{ handled: 1 }]);
  });

  it("TC-BE-039-04 reaktivasi menyimpan stake baru dan menunda status (K-36)", async () => {
    const { member } = await setup([reactivated(1011)]);
    expect(member("scraper")).toMatchObject({ stake: 100_000_000n, credit_limit: 80_000_000n, settled_history: 0n, reactivate_epoch: 44n, status: "suspended" });
  });

  it("TC-BE-039-13 reaktivasi berlaku saat epoch efektif dibuka", async () => {
    const next = block(1012, { logs: [cutoffLog({ epoch: 43, next_epoch: 44, total_obligation: "0", edge_count: 0 })] });
    const { member } = await setup([reactivated(1011), next], 11);
    // epoch 43 belum punya obligations di FX-LOG42, jadi cutoff 43 membuka epoch 44 dengan edge 0
    expect(member("scraper").status).toBe("active");
  });

  it("TC-BE-039-06 outstanding_debt anggota default memakai nilai event", async () => {
    const { member } = await setup();
    expect(member("scraper")).toMatchObject({ status: "suspended", outstanding_debt: 0n });
  });

  it("TC-BE-039-08 exitRequestedEpoch di read API", async () => {
    const { get } = await setup([exitRequested()]);
    const t = await get(`/members/${acct("translator")}`);
    expect(t.body).toMatchObject({ exitRequestedEpoch: 43, status: "active" });
    const s = await get(`/members/${acct("summarizer")}`);
    expect(s.body.exitRequestedEpoch).toBeNull();
  });

  it("TC-BE-039-09 anggota exited di read API", async () => {
    const { get } = await setup([exitRequested(), withdrawn()]);
    const { body } = await get("/members?status=exited");
    expect(body.items.map((m: { account: string }) => m.account)).toEqual([acct("translator")]);
    expect(body.items[0]).toMatchObject({ status: "exited", stake: "0" });
  });
});
