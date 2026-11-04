import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acct, listen, seedAg6, seedCircle, seedEpoch, type TestServer } from "../helpers/d9-fixtures.js";

const DIR = fileURLToPath(new URL("../../docs/api-schemas/", import.meta.url));
const readJson = (rel: string): any => JSON.parse(readFileSync(DIR + rel, "utf8"));

interface Entry {
  method: string;
  path: string;
  request?: string;
  response: string | null;
  item: string;
  pending?: string;
}

const index = readJson("index.json") as { endpoints: Entry[]; error: string };

/** Endpoints of tables 2.1 and 2.2 of the Backend API spec. */
const SPEC_ENDPOINTS = [
  "GET /x207/health",
  "GET /x207/circles/{circle}/members",
  "GET /x207/circles/{circle}/members/{account}",
  "GET /x207/circles/{circle}/members/{account}/limits",
  "GET /x207/circles/{circle}/members/{account}/settlements",
  "GET /x207/circles/{circle}/epochs",
  "GET /x207/circles/{circle}/epochs/{n}",
  "GET /x207/circles/{circle}/epochs/{n}/obligations",
  "GET /x207/circles/{circle}/epochs/{n}/settlements",
  "GET /x207/circles/{circle}/epochs/{n}/metrics",
  "GET /x207/circles/{circle}/params",
  "GET /x207/circles/{circle}/params/history",
  "GET /x207/circles/{circle}/proposals",
  "POST /x207/circles/{circle}/intents",
  "GET /x207/circles/{circle}/intents",
  "GET /x207/circles/{circle}/bundles",
  "POST /x207/settlement/deposit/quote",
  "GET /x207/settlement/jobs/{jobId}",
  "POST /x207/settlement/withdraw/quote",
  "POST /x207/settlement/withdraw/intent",
  "POST /x207/settlement/withdraw/submit",
];

function buildAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "index.json")) {
    ajv.addSchema(readJson(file));
  }
  return ajv;
}

describe("BE-014 endpoint schemas in docs/api-schemas", () => {
  const ajv = buildAjv();
  const validator = (name: string): ValidateFunction => {
    const v = ajv.getSchema(name);
    if (!v) throw new Error(`schema ${name} does not exist`);
    return v;
  };

  it("TC-BE-014-15 every endpoint of tables 2.1 and 2.2 is listed in index.json", () => {
    const listed = index.endpoints.map((e) => `${e.method} ${e.path}`);
    expect([...listed].sort()).toEqual([...SPEC_ENDPOINTS].sort());
  });

  it("TC-BE-014-15 every endpoint with a spec format has a schema and an example that pass validation", () => {
    for (const e of index.endpoints) {
      if (e.response === null) {
        expect(e.pending, `${e.method} ${e.path} without a schema must have a reason`).toBeTruthy();
        continue;
      }
      for (const name of [e.request, e.response].filter((n): n is string => Boolean(n))) {
        const validate = validator(name);
        const example = readJson(`examples/${name}`);
        const ok = validate(example);
        expect(ok, `${e.method} ${e.path} (${name}): ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  });

  it("error example passes the error schema", () => {
    const validate = validator(index.error);
    expect(validate(readJson("examples/error.json"))).toBe(true);
    const below = {
      error: {
        code: "below_withdraw_threshold",
        message: "Withdrawals to Base need at least 0.25 USD; 0.10 USD would lose about 2.55%",
        details: { chain: "base", minAmount: "250000", amount: "100000", withdrawFee: "2400", estimatedLossPct: 2.55 },
      },
    };
    expect(validate(below)).toBe(true);
  });

  it("default entry 4.4 passes the 207 report schema", () => {
    const report = readJson("examples/report-207.json");
    report.phase = "finalized";
    report.finalized = true;
    report.members = [
      {
        account: "scraper.x207-circle.near", status: 409, net: "-35000000", settlement: "defaulted",
        amount: "35000000", stakeSlashed: "35000000", haircut: "0",
      },
    ];
    expect(validator("report-207.json")(report)).toBe(true);
  });

  it("schema rejects unit violations (numeric amount, unsigned net, non-UTC time)", () => {
    const member = readJson("examples/member.json");
    expect(validator("member.json")({ ...member, stake: 50000000 })).toBe(false);
    expect(validator("member.json")({ ...member, joinedAt: "2026-11-03T08:12:44+07:00" })).toBe(false);
    const report = readJson("examples/report-207.json");
    report.members[3].net = "35000000";
    expect(validator("report-207.json")(report)).toBe(false);
  });
});

describe("BE-014 live responses pass the schema (contract)", () => {
  let db: Database.Database;
  let srv: TestServer;
  const ajv = buildAjv();

  beforeAll(async () => {
    db = new Database(":memory:");
    seedCircle(db);
    seedAg6(db);
    seedEpoch(db, { epoch: 42, phase: "clearing", cutoffAt: "2026-11-09T11:19:56Z", proposalDeadline: "2026-11-09T11:29:56Z",
      closedAt: "2026-11-09T11:19:56Z", edgeCount: 7, totalObligation: 190_000_000 });
    seedEpoch(db, { epoch: 43, phase: "open" });
    srv = await listen({ db });
  });

  afterAll(async () => {
    await srv.close();
    db.close();
  });

  const check = async (path: string, schema: string, status = 200) => {
    const res = await fetch(srv.url + path);
    expect(res.status).toBe(status);
    const body = await res.json();
    const validate = ajv.getSchema(schema)!;
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  };

  it("member list", () => check("/x207/circles/agents-main/members", "members-list.json"));
  it("single member", () => check(`/x207/circles/agents-main/members/${acct("scraper")}`, "member.json"));
  it("epoch list", () => check("/x207/circles/agents-main/epochs", "epochs-list.json"));
  it("error 404 member", () => check("/x207/circles/agents-main/members/nobody.near", "error.json", 404));
  it("error 400 limit", () => check("/x207/circles/agents-main/members?limit=999", "error.json", 400));
  it("error 404 circle", () => check("/x207/circles/nope/epochs", "error.json", 404));
});
