// Registry D10 of the DAOs that put the vote up for rent (BE-061, ADR-47 point 4). The contract does not hold it, so the circle's governance gives it to the backend (a file named by
// `X207_DAO_REGISTRY_PATH`, changed when the governance decides) and the backend serves it to the brokers: a broker that a grantor runs on its own machine must not be able to write the
// list of what a DAO allows. Each DAO lists `rentable_vote_kinds: [{kind, contract}]`, where `contract` is the contract that handles ONLY that kind (a general delegation covers every
// proposal, the treasury too, and cannot be rented). `treasury`, `code_upgrade` and `council` are never for rent, so a registry that lists one of them is refused when it is loaded.
// The broker checks what it receives again with the same rules (`broker/src/provider/dao-vote.ts`).
import { readFileSync } from "node:fs";
import type { Route } from "../api/router.js";

export const FORBIDDEN_VOTE_KINDS: readonly string[] = ["treasury", "code_upgrade", "council"];
const KIND = /^[a-z][a-z0-9_]{1,31}$/;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const isAccount = (v: unknown): v is string => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT.test(v);

export interface DaoRegistryItem {
  dao: string;
  rentable_vote_kinds: Array<{ kind: string; contract: string | null }>;
}

export class DaoRegistryError extends Error {}

export function parseDaoRegistry(text: string): DaoRegistryItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DaoRegistryError("DAO registry is not JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new DaoRegistryError("DAO registry must be an object {DAO account: {rentable_vote_kinds}}");
  const items: DaoRegistryItem[] = [];
  for (const [dao, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAccount(dao)) throw new DaoRegistryError(`${JSON.stringify(dao)} is not a NEAR account`);
    const kinds = (entry as { rentable_vote_kinds?: unknown } | null)?.rentable_vote_kinds ?? [];
    if (!Array.isArray(kinds)) throw new DaoRegistryError(`${dao}: rentable_vote_kinds must be a list`);
    const list: DaoRegistryItem["rentable_vote_kinds"] = [];
    for (const item of kinds as unknown[]) {
      const kind = typeof item === "string" ? item : (item as { kind?: unknown } | null)?.kind;
      const contract = typeof item === "string" ? null : (item as { contract?: unknown } | null)?.contract ?? null;
      if (typeof kind !== "string" || !KIND.test(kind)) throw new DaoRegistryError(`${dao}: kind must be text matching [a-z][a-z0-9_]{1,31}`);
      if (FORBIDDEN_VOTE_KINDS.includes(kind)) throw new DaoRegistryError(`${dao}: kind ${kind} cannot be rented out (vote_kind_forbidden)`);
      if (contract !== null && !isAccount(contract)) throw new DaoRegistryError(`${dao}: contract for ${kind} is not a NEAR account`);
      if (!list.some((k) => k.kind === kind)) list.push({ kind, contract });
    }
    items.push({ dao, rentable_vote_kinds: list });
  }
  return items;
}

export const daoRegistryFromFile = (path: string): DaoRegistryItem[] => parseDaoRegistry(readFileSync(path, "utf8"));

export const daoRegistryRoutes = (registry: readonly DaoRegistryItem[]): Route[] => [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/marketplace/dao-registry",
    circleScoped: true,
    handler: () => ({ status: 200, body: { items: registry, forbidden: [...FORBIDDEN_VOTE_KINDS], source: "circle-governance" } }),
  },
];
