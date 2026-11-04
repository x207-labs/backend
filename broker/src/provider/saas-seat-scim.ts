// SaaS team seat adapter over SCIM 2.0 (BE-087, ADR-47 group B, catalog #17 `saas:team-seat`, RFC 7643 and RFC 7644): a generic P2 adapter for any SaaS that provisions users by SCIM. The SCIM token of
// the grantor stays on the machine of the broker. A grant makes a USER in one GROUP of the scope; the end of the rent closes the seat:
//   POST   {base}/Users                 {schemas, userName, externalId: "x207-<grant>", active: true}  -> 201 {id}      (409: the user exists and is NOT ours: refused, never taken over)
//   GET    {base}/Groups/{group}        -> {id, members: [{value}]};   PUT {base}/Groups/{group}  the same resource with the member added or removed (RFC 7644 3.5.1)
//   GET    {base}/Users/{id}            -> {id, active, groups: [{value}]};   PUT {base}/Users/{id}  the resource with `active: false`   (revoke, step 1)
//   DELETE {base}/Users/{id}                                                                         -> 204 or 404          (revoke, step 2)
// Scope of the grant: `resource` = the id of the SCIM group (it must be in `allowedGroups`: a group outside is refused before any call), `permission` is not used, `grantee_ref` = the `userName` of the
// seat (an e-mail). Seats have no end date in SCIM, so the broker removes the seat at the end of the paid day (`revoke`, with the retry of the manager); a renewal keeps the same user.
// Group membership is read and written with `GET` and `PUT` (the shared HTTP helper has no `PATCH`); two writers of the same group at once can lose an update, and the grantor should keep one broker
// per SCIM tenant. The seat is checked at the provider before it is called active: `status` is `active` only for an active user that is in the group.
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, ProviderHttpError, type FetchLike } from "./http.js";

export interface SaasSeatScimOptions {
  /** Base URL (https) of the SCIM service, e.g. `https://example.com/scim/v2`. */
  baseUrl: string;
  /** The SCIM bearer token of the grantor. Never delivered, never logged. */
  token: string;
  /** The ids of the SCIM groups a grant may use. */
  allowedGroups: readonly string[];
  fetch?: FetchLike;
}

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,127}$/;

/** `sc:<grant id>:<user id>:<group id>`: all that `revoke` and `status` need. Not a secret. */
const handleOf = (grantId: number, user: string, group: string): string => `sc:${grantId}:${user}:${group}`;
const parseHandle = (handle: string): { user: string; group: string } => {
  const m = /^sc:(\d+):([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,64})$/.exec(handle);
  if (!m) throw new Error("unknown SCIM handle");
  return { user: m[2] as string, group: m[3] as string };
};

type Resource = Record<string, unknown> & { members?: Array<{ value?: unknown }> };

export class SaasSeatScimAdapter implements ProviderAccessAdapter {
  readonly provider = "saas-seat-scim";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly #o: SaasSeatScimOptions;
  readonly #base: string;
  readonly #allowed: ReadonlySet<string>;
  readonly #fetch: FetchLike;
  /** One writer per group at a time in this process: the read and the write of a group are one step (security review batch 8). */
  readonly #groupLocks = new Map<string, Promise<void>>();

  constructor(options: SaasSeatScimOptions) {
    if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(options.baseUrl)) throw new Error("baseUrl must be an https URL");
    if (options.token === "") throw new Error("token is required");
    if (options.allowedGroups.length === 0) throw new Error("allowedGroups is empty: name at least one SCIM group");
    for (const g of options.allowedGroups) if (!GROUP_ID.test(g)) throw new Error(`allowedGroups: ${JSON.stringify(g)} is not a SCIM group id`);
    this.#o = options;
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#allowed = new Set(options.allowedGroups);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#o.token}`, accept: "application/scim+json", "content-type": "application/scim+json", "user-agent": "x207-broker" };
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return USER_NAME.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref is the userName of the seat (an e-mail): 1 to 128 characters [A-Za-z0-9._+@-]" };
  }

  /** A seat is one user in one group: a second grant for the same pair would lose its seat when the first ends (B4-F2). */
  sharedKey({ granteeRef, resource }: { granteeRef: string; resource: string | null }): string | null {
    return resource === null ? null : `saas-seat-scim:${resource}:${granteeRef}`;
  }

  #group(request: ProviderGrantRequest): string {
    const group = request.resource ?? "";
    if (!GROUP_ID.test(group)) throw new Error("resource must be the id of a SCIM group");
    if (!this.#allowed.has(group)) throw new Error(`group ${group} is not one of the groups this broker may use`);
    return group;
  }

  async #get(path: string): Promise<Resource | null> {
    const r = await call(this.#fetch, "", this.#headers(), { method: "GET", path: `${this.#base}${path}` }, [200, 404]);
    return r.status === 404 ? null : (JSON.parse(r.text) as Resource);
  }

  /** Adds or removes one member of the group by reading the group and writing it back (RFC 7644 3.5.1). */
  async #member(group: string, user: string, present: boolean): Promise<void> {
    // Two seats made at the same time for one group read the same list and the second PUT erased the first member; now the second reads after the first has written
    const before = this.#groupLocks.get(group) ?? Promise.resolve();
    let release!: () => void;
    const mine = before.then(() => new Promise<void>((resolve) => (release = resolve)));
    this.#groupLocks.set(group, mine);
    await before;
    try {
      await this.#memberNow(group, user, present);
    } finally {
      release();
      if (this.#groupLocks.get(group) === mine) this.#groupLocks.delete(group);
    }
  }

  async #memberNow(group: string, user: string, present: boolean): Promise<void> {
    const g = await this.#get(`/Groups/${group}`);
    if (g === null) {
      if (present) throw new Error(`group ${group} does not exist at the provider`);
      return;
    }
    const members = (g.members ?? []).filter((m) => typeof m.value === "string");
    const has = members.some((m) => m.value === user);
    if (has === present) return;
    const next = present ? [...members, { value: user }] : members.filter((m) => m.value !== user);
    await call(this.#fetch, "", this.#headers(), { method: "PUT", path: `${this.#base}/Groups/${group}`, body: JSON.stringify({ ...g, members: next }) }, [200]);
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const group = this.#group(request);
    const delivery = { provider: "saas-seat-scim", userName: request.granteeRef, group, note: "the invitation to set a password or sign in goes from the SaaS to this user name" };
    // the rent of the next day: the seat is there
    if (request.existingHandle) {
      const old = parseHandle(request.existingHandle);
      const user = await this.#get(`/Users/${old.user}`);
      if (user !== null && user.active === true && old.group === group) {
        await this.#member(group, old.user, true); // a seat that was taken out of its group at the provider goes back in: the lessee paid for it
        return { handle: request.existingHandle, nativeExpiresAtMs: null, delivery };
      }
    }
    const made = await call(
      this.#fetch, "", this.#headers(),
      { method: "POST", path: `${this.#base}/Users`, body: JSON.stringify({ schemas: [USER_SCHEMA], userName: request.granteeRef, externalId: `x207-${request.grantId}`, active: true }) },
      [200, 201, 409],
    );
    // a user that already exists was not made for this grant: revoke would delete a real person
    if (made.status === 409) throw new Error(`userName ${request.granteeRef} already exists at the provider and is not a seat of this broker; it was not changed`);
    const id = (JSON.parse(made.text) as { id?: unknown }).id;
    if (typeof id !== "string" || !ID.test(id)) throw new Error("the provider answered the user without a usable id");
    try {
      await this.#member(group, id, true);
    } catch (error) {
      await this.#delete(id).catch(() => undefined); // no seat without its group
      throw error;
    }
    return { handle: handleOf(request.grantId, id, group), nativeExpiresAtMs: null, delivery };
  }

  async #delete(user: string): Promise<void> {
    await call(this.#fetch, "", this.#headers(), { method: "DELETE", path: `${this.#base}/Users/${user}` }, [200, 204, 404]);
  }

  /** `active: false` first (the seat stops at once even if the delete fails), the group, then the delete. A user that is gone is a success. */
  async revoke(handle: string): Promise<void> {
    const h = parseHandle(handle);
    const user = await this.#get(`/Users/${h.user}`);
    if (user !== null && user.active !== false) {
      await call(this.#fetch, "", this.#headers(), { method: "PUT", path: `${this.#base}/Users/${h.user}`, body: JSON.stringify({ ...user, active: false }) }, [200, 404]);
    }
    await this.#member(h.group, h.user, false);
    await this.#delete(h.user);
  }

  async status(handle: string): Promise<AccessState> {
    const h = parseHandle(handle);
    try {
      const user = await this.#get(`/Users/${h.user}`);
      if (user === null || user.active !== true) return "absent";
      const group = await this.#get(`/Groups/${h.group}`);
      return group !== null && (group.members ?? []).some((m) => m.value === h.user) ? "active" : "absent";
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return "absent";
      throw error;
    }
  }
}
