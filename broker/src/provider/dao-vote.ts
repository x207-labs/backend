// Rent of the vote of a DAO, limited (BE-061, ADR-47 point 4, the owner chose option C). The holder of the tokens (the grantor) delegates its voting power to the lessee for ONE kind of vote
// and only if the DAO has said, in the registry D10, that this kind may be rented: `rentable_vote_kinds` of that DAO, filled by the governance of the circle (for example `gauge_weight`, like
// the markets of bribes for gauges that already exist in DeFi). A DAO with no list refuses every rent. Treasury, code upgrade and council (the people who run the DAO) are NEVER rented:
// a registry that lists them is refused when it is loaded, and the adapter refuses them again at the grant. The holder may take the delegation back at any time on the DAO itself (the adapter
// reports it as `absent`), and every vote is public on the DAO: the delivery names where.
import { readFileSync } from "node:fs";
import type { AccessState, ProveGranteeArgs, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { ProviderAccessError } from "./adapter.js";

/** Kinds of vote that no DAO can put up for rent. */
export const FORBIDDEN_VOTE_KINDS: readonly string[] = ["treasury", "code_upgrade", "council"];
const KIND = /^[a-z][a-z0-9_]{1,31}$/;
const ACCOUNT = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

/** One kind of vote that a DAO puts up for rent, and the contract that handles ONLY that kind. `contract: null` means the DAO has no such contract (only a general delegation). */
export interface RentableKind {
  readonly kind: string;
  readonly contract: string | null;
}
/** The registry D10 for DAOs: DAO account -> `{rentable_vote_kinds: [{kind, contract}]}`. */
export type DaoRegistry = Readonly<Record<string, { readonly rentable_vote_kinds: readonly RentableKind[] }>>;

export class DaoRegistryError extends Error {}

/**
 * Parses and checks the registry; a kind that can never be rented, or a malformed entry, is an error (the governance made a mistake), not something to ignore. A kind written as a plain
 * text, or an object with no `contract`, is kept with `contract: null`: it is refused at the grant as `delegation_not_scoped`, never delegated by default.
 */
export function parseDaoRegistry(text: string): DaoRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DaoRegistryError("registri DAO bukan JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new DaoRegistryError("registri DAO harus objek {akun DAO: {rentable_vote_kinds}}");
  const out: Record<string, { rentable_vote_kinds: RentableKind[] }> = {};
  for (const [dao, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!ACCOUNT.test(dao) || dao.length < 2 || dao.length > 64) throw new DaoRegistryError(`${JSON.stringify(dao)} bukan akun NEAR`);
    const kinds = (entry as { rentable_vote_kinds?: unknown } | null)?.rentable_vote_kinds;
    if (kinds === undefined) {
      out[dao] = { rentable_vote_kinds: [] }; // no list: nothing is for rent
      continue;
    }
    if (!Array.isArray(kinds)) throw new DaoRegistryError(`${dao}: rentable_vote_kinds harus daftar`);
    const list: RentableKind[] = [];
    for (const item of kinds as unknown[]) {
      const kind = typeof item === "string" ? item : (item as { kind?: unknown } | null)?.kind;
      const contract = typeof item === "string" ? null : (item as { contract?: unknown } | null)?.contract ?? null;
      if (typeof kind !== "string" || !KIND.test(kind)) throw new DaoRegistryError(`${dao}: kind harus teks [a-z][a-z0-9_]{1,31}`);
      if (FORBIDDEN_VOTE_KINDS.includes(kind)) throw new DaoRegistryError(`${dao}: jenis ${kind} tidak boleh disewakan (vote_kind_forbidden)`);
      if (contract !== null && (typeof contract !== "string" || !ACCOUNT.test(contract) || contract.length < 2 || contract.length > 64)) throw new DaoRegistryError(`${dao}: contract untuk ${kind} bukan akun NEAR`);
      if (!list.some((k) => k.kind === kind)) list.push({ kind, contract: contract as string | null });
    }
    out[dao] = { rentable_vote_kinds: list };
  }
  return out;
}

/** The registry from the read API of the backend (the circle's governance fills it, ADR-28): `GET /x207/circles/{circle}/marketplace/dao-registry`, checked again here. */
export async function fetchDaoRegistry(options: { readApiUrl: string; circle: string; fetch?: typeof fetch }): Promise<DaoRegistry> {
  const url = `${options.readApiUrl.replace(/\/+$/, "")}/x207/circles/${encodeURIComponent(options.circle)}/marketplace/dao-registry`;
  const r = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new DaoRegistryError(`read API ${r.status} untuk registri DAO`);
  const body = (await r.json()) as { items?: Array<{ dao?: unknown; rentable_vote_kinds?: unknown }> };
  const map: Record<string, unknown> = {};
  for (const item of body.items ?? []) if (typeof item.dao === "string") map[item.dao] = { rentable_vote_kinds: item.rentable_vote_kinds };
  return parseDaoRegistry(JSON.stringify(map));
}

/** A registry from a local file: for tests and for the `hosted` mode with mock providers only. A self-hosted broker reads the registry of the circle, not a file that its operator can write. */
export const daoRegistryFromFile = (path: string): DaoRegistry => parseDaoRegistry(readFileSync(path, "utf8"));

/** What the adapter needs from a DAO. A mock in the tests; a client of the real DAO contract later. */
export interface DaoClient {
  /** The holder delegates its voting power for `kind` to `delegate` until `expiresAtMs`, ONLY at `contract` (the contract that handles that kind and nothing else); returns an id of the delegation. */
  delegate(args: { dao: string; contract: string; kind: string; delegate: string; expiresAtMs: number }): Promise<{ id: string; expiresAtMs: number | null }>;
  undelegate(args: { dao: string; id: string }): Promise<void>;
  /** Is the delegation still there? */
  isDelegated(args: { dao: string; id: string }): Promise<boolean>;
  accountExists(account: string): Promise<boolean>;
  /** Where the votes of the DAO are public (a URL or a path of the read API). */
  recordOf(dao: string): string;
}

export interface DaoVoteOptions {
  /** The registry, or a function that gives the current one (read from the backend at every grant, so a decision of the governance applies at once). */
  registry: DaoRegistry | (() => Promise<DaoRegistry>);
  client: DaoClient;
  /** The DAO closes the delegation by itself at its end. */
  nativeExpiry?: boolean;
}

export class DaoVoteAdapter implements ProviderAccessAdapter {
  readonly provider = "dao-vote";
  /** Talks to a real DAO with the account of the grantor. */
  readonly real = true;
  readonly nativeExpiry: boolean;
  readonly #o: DaoVoteOptions;

  constructor(options: DaoVoteOptions) {
    this.#o = options;
    this.nativeExpiry = options.nativeExpiry ?? false;
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!ACCOUNT.test(ref)) return { ok: false, reason: "bukan akun NEAR" };
    return (await this.#o.client.accountExists(ref)) ? { ok: true } : { ok: false, reason: "akun penerima delegasi tidak ada" };
  }

  /** The account that receives the delegation must be the account that signs the vouchers of the lessee: the vote cannot be rented on to another account. No proof is sent. */
  async proveGranteeRef(args: ProveGranteeArgs): Promise<boolean> {
    return args.granteeAccount !== null && args.granteeAccount === args.ref;
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const dao = request.resource;
    const kind = request.permission;
    if (dao === null || kind === null) throw new ProviderAccessError("scope_invalid", "grant dao-vote wajib menamai DAO (resource) dan jenis suara (permission)");
    if (FORBIDDEN_VOTE_KINDS.includes(kind)) throw new ProviderAccessError("vote_kind_forbidden", `suara ${kind} tidak pernah disewakan`);
    const registry = typeof this.#o.registry === "function" ? await this.#o.registry() : this.#o.registry;
    const entry = registry[dao];
    if (entry === undefined) throw new ProviderAccessError("dao_unknown", `DAO ${dao} tidak ada di registri D10: tidak ada sewa suara`);
    const rentable = entry.rentable_vote_kinds.find((k) => k.kind === kind);
    if (rentable === undefined) throw new ProviderAccessError("vote_kind_forbidden", `DAO ${dao} tidak mengizinkan sewa suara ${kind} (rentable_vote_kinds)`);
    // a general delegation covers every proposal, the treasury too: only a contract that handles this kind alone may be delegated to
    if (rentable.contract === null || rentable.contract === dao) {
      throw new ProviderAccessError("delegation_not_scoped", `DAO ${dao} tidak punya kontrak yang hanya mengurus suara ${kind}: delegasi umum tidak disewakan`);
    }
    const made = await this.#o.client.delegate({ dao, contract: rentable.contract, kind, delegate: request.granteeRef, expiresAtMs: request.expiresAtMs });
    return {
      handle: `dao:${dao}:${made.id}`, nativeExpiresAtMs: this.nativeExpiry ? made.expiresAtMs : null,
      delivery: { provider: "dao-vote", dao, contract: rentable.contract, kind, delegate: request.granteeRef, record: this.#o.client.recordOf(dao) },
    };
  }

  #decode(handle: string): { dao: string; id: string } {
    const m = /^dao:([^:]+):(.+)$/.exec(handle);
    if (!m) throw new Error("handle dao-vote tidak dikenal");
    return { dao: m[1] as string, id: m[2] as string };
  }

  async revoke(handle: string): Promise<void> {
    await this.#o.client.undelegate(this.#decode(handle));
  }

  async status(handle: string): Promise<AccessState> {
    return (await this.#o.client.isDelegated(this.#decode(handle))) ? "active" : "absent";
  }
}
