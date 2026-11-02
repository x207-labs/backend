import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT } from "../helpers/fx-log42.js";
import { listen } from "../helpers/d9-fixtures.js";
import { fxServer } from "../helpers/fx-api.js";
import type { ViewFunction } from "../../src/settlement/intents.js";

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const proposal = (id: number, status: string, receiver: string, method: string, args: unknown) => ({
  id, proposer: "alice.near", description: `p${id}`, status, submission_time: "1793836800000000000",
  vote_counts: { council: [1, 0, 0] },
  kind: { FunctionCall: { receiver_id: receiver, actions: [{ method_name: method, args: b64(args), deposit: "0", gas: "30000000000000" }] } },
});
const PARAMS = { epoch_length: 7200 };

function view(proposals: unknown[], fail = false): ViewFunction {
  return async (contract, method) => {
    if (fail) throw new Error("rpc down");
    if (method === "get_owner") return "x207.sputnik-dao.near";
    if (method === "get_last_proposal_id") return proposals.length;
    if (method === "get_proposals") return proposals;
    throw new Error(`${contract}.${method}`);
  };
}

describe("BE-023 GET /x207/circles/{circle}/proposals", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  async function get(v: ViewFunction, query = "") {
    const base = await fxServer(8);
    const srv = await listen({ db: base.db, daoView: v });
    close = async () => (await srv.close(), await base.close());
    const res = await fetch(`${srv.url}/x207/circles/agents-main/proposals${query}`);
    return { res, json: (await res.json()) as Record<string, any> };
  }

  const data = [
    proposal(0, "Approved", CONTRACT, "set_params", { params: PARAMS }),
    proposal(1, "InProgress", CONTRACT, "set_params", { params: { epoch_length: 3600 } }),
    proposal(2, "InProgress", "other.near", "set_params", { params: PARAMS }),
    proposal(3, "InProgress", CONTRACT, "admit_member", { account_id: "x.near" }),
    { id: 4, proposer: "a.near", description: "transfer", status: "InProgress", submission_time: "1", kind: { Transfer: {} } },
  ];

  it("lists only set_params proposals for the circle contract, newest first, with decoded params", async () => {
    const { res, json } = await get(view(data));
    expect(res.status).toBe(200);
    expect(json.dao).toBe("x207.sputnik-dao.near");
    expect(json.items.map((i: { id: number }) => i.id)).toEqual([1, 0]);
    expect(json.items[1]).toMatchObject({ status: "Approved", method: "set_params", params: PARAMS, proposer: "alice.near", votes: { council: [1, 0, 0] } });
    expect(json.items[0].submittedAt).toBe("2026-11-05T00:00:00Z");
  });

  it("filters by status and rejects an unknown status", async () => {
    const ok = await get(view(data), "?status=Approved");
    expect(ok.json.items.map((i: { id: number }) => i.id)).toEqual([0]);
    await close?.();
    const bad = await get(view(data), "?status=Nope");
    expect([bad.res.status, bad.json.error.code]).toEqual([400, "invalid_request"]);
  });

  it("answers 502 dao_unavailable when the DAO view fails", async () => {
    const { res, json } = await get(view([], true));
    expect([res.status, json.error.code]).toEqual([502, "dao_unavailable"]);
  });

  it("keeps a proposal whose args cannot be decoded, with params null", async () => {
    const broken = { ...proposal(5, "InProgress", CONTRACT, "set_params", {}), };
    (broken.kind.FunctionCall.actions[0] as { args: string }).args = Buffer.from("not json").toString("base64");
    const { json } = await get(view([broken]));
    expect(json.items[0]).toMatchObject({ id: 5, params: null });
  });
});
