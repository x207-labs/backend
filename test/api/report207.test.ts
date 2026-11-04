import { afterEach, describe, expect, it } from "vitest";
import { fxServer } from "../helpers/fx-api.js";
import { acct } from "../helpers/fx-log42.js";
import { formatNet, memberStatus } from "../../src/report207/index.js";

const BASE = "/x207/circles/agents-main";

describe("BE-020 GET …/epochs/{n} (207 report)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function get(path: string, upTo: number) {
    const s = await fxServer(upTo);
    close = s.close;
    const res = await fetch(`${s.srv.url}${BASE}${path}`);
    return { res, body: await res.json(), headers: res.headers };
  }
  const byName = (body: { members: { account: string }[] }, name: string) => body.members.find((m) => m.account === acct(name));

  // L25 = block 8: commit_epoch has run, nobody has paid yet.
  it("TC-BE-020-01 payment_window epoch answers 207 with the report header", async () => {
    const { res, body, headers } = await get("/epochs/42", 8);
    expect(res.status).toBe(207);
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(headers.get("x-x207-indexed-block")).not.toBeNull();
    expect(body).toMatchObject({
      circle: "agents-main", network: "x207:agents-main", epoch: 42, phase: "payment_window", committed: true, finalized: false,
      unit: "credit", decimals: 6, totalObligation: "190000000", cleared: "145000000", clearedRatio: 0.7632,
      committedAt: "2026-11-09T11:30:00Z", paymentDeadline: "2026-11-09T12:00:00Z",
    });
  });

  it("TC-BE-020-02 status per member sorted by account", async () => {
    const { body } = await get("/epochs/42", 8);
    expect(body.members.map((m: { account: string }) => m.account)).toEqual(
      ["cleaner", "gpu", "image", "scraper", "summarizer", "translator"].map(acct),
    );
    expect(byName(body, "cleaner")).toMatchObject({ status: 402, net: "-10000000", settlement: "due", amount: "10000000", due: "2026-11-09T12:00:00Z", haircut: "0" });
    expect(byName(body, "scraper")).toMatchObject({ status: 402, net: "-35000000", settlement: "due", amount: "35000000" });
    expect(byName(body, "gpu")).toMatchObject({ status: 202, net: "+45000000", settlement: "claimable", amount: "45000000", claimable: false });
    for (const name of ["image", "summarizer", "translator"]) {
      expect(byName(body, name)).toMatchObject({ status: 200, net: "0", settlement: null, haircut: "0" });
    }
  });

  it("TC-BE-020-03 cleared per member and the total equals the header", async () => {
    const { body } = await get("/epochs/42", 8);
    const cleared = Object.fromEntries(body.members.map((m: { account: string; cleared: string }) => [m.account, m.cleared]));
    expect(cleared).toEqual({
      [acct("translator")]: "30000000", [acct("summarizer")]: "30000000", [acct("image")]: "30000000",
      [acct("scraper")]: "15000000", [acct("cleaner")]: "20000000", [acct("gpu")]: "20000000",
    });
    const sum = body.members.reduce((s: bigint, m: { cleared: string }) => s + BigInt(m.cleared), 0n);
    expect(sum).toBe(BigInt(body.cleared));
  });

  it("TC-BE-020-04 a paid debtor has status 200 paid", async () => {
    const { body } = await get("/epochs/42", 9);
    expect(byName(body, "cleaner")).toMatchObject({ status: 200, settlement: "paid", net: "-10000000" });
    expect(byName(body, "scraper")).toMatchObject({ status: 402 });
  });

  it("TC-BE-020-05 after finalization a non-paying debtor is 409 and the creditor can claim", async () => {
    const { body } = await get("/epochs/42", 10);
    expect(body).toMatchObject({ phase: "finalized", finalized: true, committed: true });
    expect(byName(body, "scraper")).toMatchObject({ status: 409, settlement: "defaulted", amount: "35000000", stakeSlashed: "35000000", haircut: "0" });
    expect(byName(body, "gpu")).toMatchObject({ status: 202, settlement: "claimable", claimable: true });
  });

  it("TC-BE-020-06 after the claim the creditor has status 200 claimed", async () => {
    const { body } = await get("/epochs/42", 11);
    expect(byName(body, "gpu")).toMatchObject({ status: 200, settlement: "claimed" });
  });

  it("TC-BE-020-07 status mapping from D5", () => {
    expect([null, "paid", "claimed", "due", "claimable", "defaulted"].map(memberStatus)).toEqual([200, 200, 200, 402, 202, 409]);
  });

  it("TC-BE-020-08 signed net format", () => {
    expect([-35_000_000n, 45_000_000n, 0n].map(formatNet)).toEqual(["-35000000", "+45000000", "0"]);
  });

  it("TC-BE-020-09 epoch open: 200, committed false, members empty", async () => {
    const { res, body } = await get("/epochs/43", 8);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ epoch: 43, phase: "open", committed: false, finalized: false, members: [] });
  });

  it("TC-BE-020-10 epoch clearing: 200, committed false, members empty", async () => {
    const { res, body } = await get("/epochs/42", 5);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ epoch: 42, phase: "clearing", committed: false, members: [], totalObligation: "190000000" });
  });

  it("TC-BE-020-11 epoch does not exist: 404 epoch_not_found", async () => {
    const { res, body } = await get("/epochs/99", 8);
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("epoch_not_found");
  });

  it("TC-BE-020-12 circle does not exist: 404 circle_not_found", async () => {
    const s = await fxServer(8);
    close = s.close;
    const res = await fetch(`${s.srv.url}/x207/circles/nope/epochs/42`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("circle_not_found");
  });

  it("TC-BE-020-13 {n} = current uses the largest epoch", async () => {
    const { res, body } = await get("/epochs/current", 8);
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ epoch: 43, committed: false, members: [] });
  });

  it.each(["-1", "abc"])("TC-BE-020-14 {n} %s is invalid: 400 invalid_request", async (n) => {
    const { res, body } = await get(`/epochs/${n}`, 8);
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
  });
});
