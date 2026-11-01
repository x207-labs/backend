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

/** Endpoint tabel 2.1 dan 2.2 Spec API Backend. */
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

describe("BE-014 skema endpoint di docs/api-schemas", () => {
  const ajv = buildAjv();
  const validator = (name: string): ValidateFunction => {
    const v = ajv.getSchema(name);
    if (!v) throw new Error(`skema ${name} tidak ada`);
    return v;
  };

  it("TC-BE-014-15 setiap endpoint tabel 2.1 dan 2.2 tercatat di index.json", () => {
    const listed = index.endpoints.map((e) => `${e.method} ${e.path}`);
    expect([...listed].sort()).toEqual([...SPEC_ENDPOINTS].sort());
  });

  it("TC-BE-014-15 setiap endpoint dengan format spec punya skema dan contoh yang lolos validasi", () => {
    for (const e of index.endpoints) {
      if (e.response === null) {
        expect(e.pending, `${e.method} ${e.path} tanpa skema harus punya alasan`).toBeTruthy();
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

  it("contoh error lolos skema error", () => {
    const validate = validator(index.error);
    expect(validate(readJson("examples/error.json"))).toBe(true);
    const below = {
      error: {
        code: "below_withdraw_threshold",
        message: "Pencairan ke Base minimal 0,25 USD; 0,10 USD kehilangan sekitar 2,55%",
        details: { chain: "base", minAmount: "250000", amount: "100000", withdrawFee: "2400", estimatedLossPct: 2.55 },
      },
    };
    expect(validate(below)).toBe(true);
  });

  it("entri default 4.4 lolos skema laporan 207", () => {
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

  it("skema menolak pelanggaran satuan (jumlah angka, net tanpa tanda, waktu bukan UTC)", () => {
    const member = readJson("examples/member.json");
    expect(validator("member.json")({ ...member, stake: 50000000 })).toBe(false);
    expect(validator("member.json")({ ...member, joinedAt: "2026-11-03T08:12:44+07:00" })).toBe(false);
    const report = readJson("examples/report-207.json");
    report.members[3].net = "35000000";
    expect(validator("report-207.json")(report)).toBe(false);
  });
});

describe("BE-014 respons live lolos skema (contract)", () => {
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

  it("daftar anggota", () => check("/x207/circles/agents-main/members", "members-list.json"));
  it("satu anggota", () => check(`/x207/circles/agents-main/members/${acct("scraper")}`, "member.json"));
  it("daftar epoch", () => check("/x207/circles/agents-main/epochs", "epochs-list.json"));
  it("error 404 anggota", () => check("/x207/circles/agents-main/members/nobody.near", "error.json", 404));
  it("error 400 limit", () => check("/x207/circles/agents-main/members?limit=999", "error.json", 400));
  it("error 404 lingkaran", () => check("/x207/circles/nope/epochs", "error.json", 404));
});
