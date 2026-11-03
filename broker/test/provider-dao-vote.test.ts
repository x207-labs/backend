import { describe, expect, it } from "vitest";
import { DaoRegistryError, DaoVoteAdapter, FORBIDDEN_VOTE_KINDS, ProviderAccessManager, daoRegistryFromFile, fetchDaoRegistry, parseDaoRegistry, type DaoClient } from "../src/provider/index.js";
import { BrokerStore } from "../src/store.js";
import { NOW } from "./helpers.js";

const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();
const DAY = 86_400_000;
const DAO = "gauge-dao.near";
const GAUGE = "gauge-voting.gauge-dao.near";

/** A mock DAO: it keeps the delegations, can lose one (the holder takes it back on the DAO itself), and knows which accounts exist. */
function mockDao() {
  const delegations = new Map<string, { dao: string; contract: string; kind: string; delegate: string; expiresAtMs: number }>();
  let n = 0;
  const client: DaoClient = {
    async delegate(a) {
      const id = String(++n);
      delegations.set(id, a);
      return { id, expiresAtMs: a.expiresAtMs };
    },
    async undelegate({ id }) {
      delegations.delete(id);
    },
    async isDelegated({ id }) {
      return delegations.has(id);
    },
    async accountExists(account) {
      return account === "delegate.near" || account === "other.near";
    },
    recordOf: (dao) => `https://votes.example/${dao}`,
  };
  return { client, delegations };
}

const registry = parseDaoRegistry(JSON.stringify({
  [DAO]: { rentable_vote_kinds: [{ kind: "gauge_weight", contract: GAUGE }] }, "no-list-dao.near": {},
  // a DAO whose only delegation is the general one: the kind is listed with no contract of its own, or with the DAO itself as the contract
  "sputnik-dao.near": { rentable_vote_kinds: [{ kind: "gauge_weight", contract: null }] }, "plain-dao.near": { rentable_vote_kinds: ["gauge_weight"] },
  "self-dao.near": { rentable_vote_kinds: [{ kind: "gauge_weight", contract: "self-dao.near" }] },
}));
const input = (resource: string, permission: string | null, id = 1, ref = "delegate.near") => ({
  grant_id: id, grantee: ref, limits: { scope: JSON.stringify({ provider: "dao-vote", grantee_ref: ref, resource, permission }), expires_at: NS(NOW + 10 * DAY) },
});
function setup() {
  const dao = mockDao();
  const store = new BrokerStore(":memory:");
  const manager = new ProviderAccessManager({ store, now: () => NOW });
  manager.register(new DaoVoteAdapter({ registry, client: dao.client }));
  return { ...dao, manager, store };
}

describe("BE-061 limited rent of the vote of a DAO", () => {
  it("TC-BE-061-01 a kind in the list of the DAO is delegated; the delivery names the public record; the holder can take it back on the DAO", async () => {
    const { manager, delegations, store } = setup();
    const { access, delivery } = await manager.grantAccess(input(DAO, "gauge_weight"));
    expect(access).toMatchObject({ provider: "dao-vote", status: "active", granteeRef: "delegate.near" });
    expect(delivery).toEqual({ provider: "dao-vote", dao: DAO, contract: GAUGE, kind: "gauge_weight", delegate: "delegate.near", record: `https://votes.example/${DAO}` });
    expect([...delegations.values()]).toEqual([{ dao: DAO, contract: GAUGE, kind: "gauge_weight", delegate: "delegate.near", expiresAtMs: NOW + DAY }]); // only at the contract of that kind
    // the revoke of the broker removes the delegation
    await manager.revokeAccess(1, "stopped");
    expect(delegations.size).toBe(0);
    store.close();
  });

  it("TC-BE-061-02 treasury, code upgrade and council are refused with vote_kind_forbidden, and so is a kind that is not in the list; nothing is delegated", async () => {
    const { manager, delegations, store } = setup();
    for (const kind of [...FORBIDDEN_VOTE_KINDS, "gauge_other", "proposal_budget"]) {
      await expect(manager.grantAccess(input(DAO, kind)), kind).rejects.toMatchObject({ code: "vote_kind_forbidden" });
    }
    await expect(manager.grantAccess(input(DAO, null))).rejects.toMatchObject({ code: "scope_invalid" });
    expect(delegations.size).toBe(0);
    expect(manager.access(1)).toBeUndefined();
    store.close();
  });

  it("TC-BE-061-03 a DAO with no list refuses every rent, and a DAO that is not in the registry is unknown", async () => {
    const { manager, delegations, store } = setup();
    await expect(manager.grantAccess(input("no-list-dao.near", "gauge_weight"))).rejects.toMatchObject({ code: "vote_kind_forbidden" });
    await expect(manager.grantAccess(input("stranger-dao.near", "gauge_weight"))).rejects.toMatchObject({ code: "dao_unknown" });
    await expect(manager.grantAccess(input(DAO, "gauge_weight", 2, "nobody.near"))).rejects.toMatchObject({ code: "grantee_ref_unverified" });
    expect(delegations.size).toBe(0);
    store.close();
  });

  it("TC-BE-061-04 the registry is checked when it is loaded: a list with a forbidden kind or a malformed one is an error, not a silent skip", () => {
    for (const kind of FORBIDDEN_VOTE_KINDS) {
      expect(() => parseDaoRegistry(JSON.stringify({ [DAO]: { rentable_vote_kinds: ["gauge_weight", kind] } })), kind).toThrow(DaoRegistryError);
    }
    expect(() => parseDaoRegistry(JSON.stringify({ [DAO]: { rentable_vote_kinds: ["Gauge Weight"] } }))).toThrow(DaoRegistryError);
    expect(() => parseDaoRegistry(JSON.stringify({ [DAO]: { rentable_vote_kinds: "gauge_weight" } }))).toThrow(DaoRegistryError);
    expect(() => parseDaoRegistry(JSON.stringify({ "Bad Account!": {} }))).toThrow(DaoRegistryError);
    expect(() => parseDaoRegistry("not json")).toThrow(DaoRegistryError);
    expect(() => parseDaoRegistry("[]")).toThrow(DaoRegistryError);
    expect(() => parseDaoRegistry(JSON.stringify({ [DAO]: { rentable_vote_kinds: [{ kind: "gauge_weight", contract: "Bad Contract!" }] } }))).toThrow(DaoRegistryError);
    expect(parseDaoRegistry("{}")).toEqual({});
    expect(parseDaoRegistry(JSON.stringify({ [DAO]: { rentable_vote_kinds: [{ kind: "gauge_weight", contract: GAUGE }, { kind: "gauge_weight", contract: "other.near" }] } }))[DAO]!.rentable_vote_kinds).toEqual([{ kind: "gauge_weight", contract: GAUGE }]);
  });

  it("TC-BE-061-05 the holder takes the delegation back on the DAO: the status is absent, and the end of the day still revokes without error", async () => {
    const { manager, delegations, store } = setup();
    const { access } = await manager.grantAccess(input(DAO, "gauge_weight"));
    delegations.clear(); // the holder removed it on the DAO
    const adapterStatus = await (async () => {
      const a = new DaoVoteAdapter({ registry, client: mockDao().client });
      return a.status(access.handle);
    })();
    expect(adapterStatus).toBe("absent");
    expect((await manager.revokeAccess(1, "paid_until")).status).toBe("revoked");
    store.close();
  });

  it("TC-BE-061-06 a DAO that has only a general delegation is refused with delegation_not_scoped: nothing is delegated", async () => {
    const { manager, delegations, store } = setup();
    for (const dao of ["sputnik-dao.near", "plain-dao.near", "self-dao.near"]) {
      await expect(manager.grantAccess(input(dao, "gauge_weight")), dao).rejects.toMatchObject({ code: "delegation_not_scoped" });
    }
    expect(delegations.size).toBe(0);
    store.close();
  });

  it("TC-BE-061-07 the registry comes from the read API of the circle and is read again at every grant; a file is only for tests and the hosted mode", async () => {
    let body: unknown = { items: [{ dao: DAO, rentable_vote_kinds: [{ kind: "gauge_weight", contract: GAUGE }] }] };
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => (seen.push(url), new Response(JSON.stringify(body), { status: 200 }))) as unknown as typeof fetch;
    const dao = mockDao();
    const store = new BrokerStore(":memory:");
    const manager = new ProviderAccessManager({ store, now: () => NOW });
    manager.register(new DaoVoteAdapter({ registry: () => fetchDaoRegistry({ readApiUrl: "http://api.test/", circle: "agents-main", fetch: fetchImpl }), client: dao.client }));
    await manager.grantAccess(input(DAO, "gauge_weight"));
    expect(seen).toEqual(["http://api.test/x207/circles/agents-main/marketplace/dao-registry"]);
    // the governance takes the kind away: the next grant is refused at once
    body = { items: [{ dao: DAO, rentable_vote_kinds: [] }] };
    await expect(manager.grantAccess(input(DAO, "gauge_weight", 2))).rejects.toMatchObject({ code: "vote_kind_forbidden" });
    // a read API that lists a forbidden kind is not believed
    body = { items: [{ dao: DAO, rentable_vote_kinds: [{ kind: "treasury", contract: GAUGE }] }] };
    await expect(manager.grantAccess(input(DAO, "gauge_weight", 3))).rejects.toMatchObject({ code: "grant_failed" });
    await expect(fetchDaoRegistry({ readApiUrl: "http://api.test", circle: "x", fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch })).rejects.toThrow(DaoRegistryError);
    expect(typeof daoRegistryFromFile).toBe("function");
    store.close();
  });
});
