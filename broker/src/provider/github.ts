// GitHub adapter (BE-059, ADR-47 group B): a collaborator on a repository, or a seat in an organization. The token is the administrator token of the grantor and lives on the machine that
// runs the broker (self-hosted); `allowedOwners` limits the broker to the accounts the grantor names, so a grant cannot point it at another owner's repository.
//   resource "owner/repo" + permission pull|triage|push|maintain|admin  -> PUT /repos/{owner}/{repo}/collaborators/{login}   (an invitation the user accepts)
//   resource "org:<org>"                                                -> PUT /orgs/{org}/memberships/{login}             (a seat, role member)
// GitHub has no expiry for either: the broker removes the access at the end of the paid day (`revoke`, with the retry of the manager).
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, ProviderHttpError, type FetchLike } from "./http.js";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SLUG = /^[A-Za-z0-9._-]{1,100}$/;
export const GITHUB_PERMISSIONS = ["pull", "triage", "push", "maintain", "admin"] as const;

export interface GithubOptions {
  token: string;
  /** Owners (users or organizations) whose repositories and seats this broker may touch. */
  allowedOwners: readonly string[];
  baseUrl?: string;
  fetch?: FetchLike;
}

type Target = { kind: "repo"; owner: string; repo: string } | { kind: "org"; owner: string };

function parseTarget(resource: string | null, allowed: readonly string[]): Target {
  if (resource === null) throw new Error("grant GitHub wajib menamai resource (owner/repo atau org:<org>)");
  const org = /^org:(.+)$/.exec(resource);
  const t: Target | null = org ? (LOGIN.test(org[1] as string) ? { kind: "org", owner: org[1] as string } : null) : (() => {
    const [owner, repo, extra] = resource.split("/");
    return owner !== undefined && repo !== undefined && extra === undefined && LOGIN.test(owner) && SLUG.test(repo) && repo !== "." && repo !== ".." ? { kind: "repo", owner, repo } : null;
  })();
  if (t === null) throw new Error(`resource ${JSON.stringify(resource.slice(0, 80))} tidak sah`);
  if (!allowed.some((a) => a.toLowerCase() === t.owner.toLowerCase())) throw new Error(`pemilik ${t.owner} tidak ada di allowedOwners broker ini`);
  return t;
}

export class GithubAdapter implements ProviderAccessAdapter {
  readonly provider = "github";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly #o: GithubOptions;
  readonly #base: string;
  readonly #fetch: FetchLike;
  /** handle -> what to remove. */
  readonly #handles = new Map<string, { target: Target; login: string; invitationId: number | null }>();

  constructor(options: GithubOptions) {
    this.#o = options;
    this.#base = options.baseUrl ?? "https://api.github.com";
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#o.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "x207-broker", "content-type": "application/json" };
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!LOGIN.test(ref)) return { ok: false, reason: "bukan login GitHub" };
    try {
      await call(this.#fetch, this.#base, this.#headers(), { method: "GET", path: `/users/${ref}` }, [200]);
      return { ok: true };
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return { ok: false, reason: "pengguna GitHub tidak ada" };
      throw error;
    }
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const target = parseTarget(request.resource, this.#o.allowedOwners);
    const login = request.granteeRef;
    const handle = target.kind === "repo" ? `gh:${target.owner}/${target.repo}:${login}` : `gh:org:${target.owner}:${login}`;
    if (target.kind === "repo") {
      const permission = request.permission ?? "pull";
      if (!(GITHUB_PERMISSIONS as readonly string[]).includes(permission)) throw new Error(`permission ${permission} tidak dikenal`);
      const r = await call(this.#fetch, this.#base, this.#headers(), { method: "PUT", path: `/repos/${target.owner}/${target.repo}/collaborators/${login}`, body: JSON.stringify({ permission }) });
      const id = r.status === 201 ? (JSON.parse(r.text) as { id?: number }).id ?? null : null;
      this.#handles.set(handle, { target, login, invitationId: id });
      return { handle, nativeExpiresAtMs: null, delivery: { provider: "github", resource: request.resource, permission, invitation: r.status === 201 ? "pending" : "already_collaborator" } };
    }
    const r = await call(this.#fetch, this.#base, this.#headers(), { method: "PUT", path: `/orgs/${target.owner}/memberships/${login}`, body: JSON.stringify({ role: "member" }) });
    this.#handles.set(handle, { target, login, invitationId: null });
    return { handle, nativeExpiresAtMs: null, delivery: { provider: "github", resource: request.resource, membership: (JSON.parse(r.text) as { state?: string }).state ?? "pending" } };
  }

  /** The handle says what to remove, so a restart of the broker does not lose it. */
  #decode(handle: string): { target: Target; login: string; invitationId: number | null } {
    const known = this.#handles.get(handle);
    if (known) return known;
    const org = /^gh:org:([^:]+):([^:]+)$/.exec(handle);
    if (org) return { target: { kind: "org", owner: org[1] as string }, login: org[2] as string, invitationId: null };
    const repo = /^gh:([^/:]+)\/([^:]+):([^:]+)$/.exec(handle);
    if (repo) return { target: { kind: "repo", owner: repo[1] as string, repo: repo[2] as string }, login: repo[3] as string, invitationId: null };
    throw new Error("handle GitHub tidak dikenal");
  }

  async revoke(handle: string): Promise<void> {
    const { target, login, invitationId } = this.#decode(handle);
    if (target.kind === "org") {
      await call(this.#fetch, this.#base, this.#headers(), { method: "DELETE", path: `/orgs/${target.owner}/memberships/${login}` }, [200, 204, 404]);
      return;
    }
    if (invitationId !== null) await call(this.#fetch, this.#base, this.#headers(), { method: "DELETE", path: `/repos/${target.owner}/${target.repo}/invitations/${invitationId}` }, [200, 204, 404]);
    await call(this.#fetch, this.#base, this.#headers(), { method: "DELETE", path: `/repos/${target.owner}/${target.repo}/collaborators/${login}` }, [200, 204, 404]);
  }

  async status(handle: string): Promise<AccessState> {
    const { target, login } = this.#decode(handle);
    const path = target.kind === "org" ? `/orgs/${target.owner}/memberships/${login}` : `/repos/${target.owner}/${target.repo}/collaborators/${login}`;
    const r = await call(this.#fetch, this.#base, this.#headers(), { method: "GET", path }, [200, 204, 404]);
    return r.status === 404 ? "absent" : "active";
  }
}
