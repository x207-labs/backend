import { afterEach, describe, expect, it } from "vitest";
import { DaoRegistryError, parseDaoRegistry } from "../../src/marketplace/dao-registry.js";
import { startMarket, type Market } from "./helpers.js";

describe("BE-061 registry D10 of the DAOs that rent the vote", () => {
  let market: Market | undefined;
  afterEach(async () => {
    await market?.srv.close();
    market?.db.close();
  });

  it("TC-BE-061-B1 the read API serves what the governance gave, and nothing when it gave nothing", async () => {
    const registry = parseDaoRegistry(JSON.stringify({ "gauge-dao.near": { rentable_vote_kinds: [{ kind: "gauge_weight", contract: "gauge-voting.gauge-dao.near" }] }, "closed-dao.near": {} }));
    market = await startMarket(["andi"], [], undefined, { daoRegistry: registry });
    const res = await market.get("/marketplace/dao-registry");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [{ dao: "gauge-dao.near", rentable_vote_kinds: [{ kind: "gauge_weight", contract: "gauge-voting.gauge-dao.near" }] }, { dao: "closed-dao.near", rentable_vote_kinds: [] }],
      forbidden: ["treasury", "code_upgrade", "council"], source: "circle-governance",
    });
    await market.srv.close();
    market.db.close();
    market = await startMarket(["andi"]);
    expect((await market.get("/marketplace/dao-registry")).json.items).toEqual([]);
  });

  it("TC-BE-061-B2 a registry with a forbidden kind, a bad account or a bad kind is refused when loaded; a kind with no contract is kept with contract null", () => {
    for (const kind of ["treasury", "code_upgrade", "council"]) {
      expect(() => parseDaoRegistry(JSON.stringify({ "d.near": { rentable_vote_kinds: [{ kind, contract: "c.near" }] } })), kind).toThrow(DaoRegistryError);
    }
    expect(() => parseDaoRegistry(JSON.stringify({ "Bad DAO": {} }))).toThrow(DaoRegistryError);
    expect(() => parseDaoRegistry(JSON.stringify({ "d.near": { rentable_vote_kinds: [{ kind: "Gauge", contract: "c.near" }] } }))).toThrow(DaoRegistryError);
    expect(() => parseDaoRegistry(JSON.stringify({ "d.near": { rentable_vote_kinds: [{ kind: "gauge_weight", contract: "No Contract!" }] } }))).toThrow(DaoRegistryError);
    expect(() => parseDaoRegistry("[]")).toThrow(DaoRegistryError);
    expect(parseDaoRegistry(JSON.stringify({ "d.near": { rentable_vote_kinds: ["gauge_weight"] } }))).toEqual([{ dao: "d.near", rentable_vote_kinds: [{ kind: "gauge_weight", contract: null }] }]);
  });
});
