// GitHub adapter (BE-059, ADR-47 group B): a collaborator on a repository, or a seat in an organization. The token is the administrator token of the grantor and lives on the machine that
// runs the broker (self-hosted); `allowedOwners` limits the broker to the accounts the grantor names, so a grant cannot point it at another owner's repository.
//   resource "owner/repo" + permission pull|triage|push|maintain|admin  -> PUT /repos/{owner}/{repo}/collaborators/{login}   (an invitation the user accepts)
//   resource "org:<org>"                                                -> PUT /orgs/{org}/memberships/{login}             (a seat, role member)
// GitHub has no expiry for either: the broker removes the access at the end of the paid day (`revoke`, with the retry of the manager).
import { parseGranteeProof, verifyNearGistProof } from "@x207/core";
import type { AccessState, ProveGranteeArgs, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { guardedGet, type Resolver, type Transport } from "./ssrf.js";
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
  /** For the fetch of a gist (behind the SSRF guard): replace the resolver and the transport (tests). */
  gistFetch?: { resolver?: Resolver; transport?: Transport };
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

interface Handle { target: Target; login: string; grantId: number | null; invitationId: number | null; preexisting: boolean }
/**
 * The handle holds all that `revoke` needs, so a restart of the broker loses nothing: `gh:owner/repo:login` (or `gh:org:org:login`) then `|g<grant>`, `|i<invitation id>` and `|p` (the access
 * was there before the grant, so the end of the rent does not remove it). A handle without the flags is one of an older broker.
 */
function encodeHandle(h: Handle): string {
  const base = h.target.kind === "repo" ? `gh:${h.target.owner}/${h.target.repo}:${h.login}` : `gh:org:${h.target.owner}:${h.login}`;
  return `${base}${h.grantId === null ? "" : `|g${h.grantId}`}${h.invitationId === null ? "" : `|i${h.invitationId}`}${h.preexisting ? "|p" : ""}`;
}
function decodeHandle(handle: string): Handle {
  const [base = "", ...flags] = handle.split("|");
  const grantId = flags.map((f) => /^g(\d+)$/.exec(f)?.[1]).find((v) => v !== undefined);
  const inv = flags.map((f) => /^i(\d+)$/.exec(f)?.[1]).find((v) => v !== undefined);
  const common = { grantId: grantId === undefined ? null : Number(grantId), invitationId: inv === undefined ? null : Number(inv), preexisting: flags.includes("p") };
  const org = /^gh:org:([^:]+):([^:]+)$/.exec(base);
  if (org) return { target: { kind: "org", owner: org[1] as string }, login: org[2] as string, ...common };
  const repo = /^gh:([^/:]+)\/([^:]+):([^:]+)$/.exec(base);
  if (repo) return { target: { kind: "repo", owner: repo[1] as string, repo: repo[2] as string }, login: repo[3] as string, ...common };
  throw new Error("handle GitHub tidak dikenal");
}

export class GithubAdapter implements ProviderAccessAdapter {
  readonly provider = "github";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly needsChallenge = true;
  readonly #o: GithubOptions;
  readonly #base: string;
  readonly #fetch: FetchLike;

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

  /**
   * `near-gist` (SD-071): the lessee put the challenge of the grant, signed with its voucher key, in a public gist of the account that is the `grantee_ref`. The gist is fetched
   * from `https://api.github.com/gists/<id>` ONLY (the host is fixed here, the id is a hex string taken from the proof), through the SSRF guard (https, public addresses, no redirect,
   * size and time limits). The owner must be the login; the signature must be valid for the voucher key that the circle has for the lessee.
   */
  async proveGranteeRef(args: ProveGranteeArgs): Promise<boolean> {
    if (args.proof === null || args.challenge === null || args.voucherPublicKey === null) return false;
    const proof = parseGranteeProof(args.proof);
    if (proof.kind !== "near-gist") return false;
    const id = /(?:^|\/)([0-9a-f]{20,40})(?:[/?#.].*)?$/i.exec(proof.gist)?.[1];
    if (id === undefined) return false;
    await verifyNearGistProof({
      proof, challenge: args.challenge, voucherPublicKey: args.voucherPublicKey,
      fetchGist: async () => {
        const res = await guardedGet(`https://api.github.com/gists/${id}`, { ...(this.#o.gistFetch?.resolver ? { resolver: this.#o.gistFetch.resolver } : {}), ...(this.#o.gistFetch?.transport ? { transport: this.#o.gistFetch.transport } : {}), maxBytes: 262_144 });
        if (!res.reachable || res.status !== 200) throw new Error(`GitHub menjawab ${res.reachable ? res.status : "tidak terjangkau"}`);
        const gist = JSON.parse(res.body) as { owner?: { login?: string }; files?: Record<string, { content?: string; truncated?: boolean }> };
        const owner = gist.owner?.login;
        if (typeof owner !== "string") throw new Error("gist tanpa pemilik");
        return { owner, files: Object.values(gist.files ?? {}).filter((f) => f.truncated !== true && typeof f.content === "string").map((f) => f.content as string) };
      },
    });
    return true;
  }

  sharedKey(args: { granteeRef: string; resource: string | null }): string | null {
    return args.resource === null ? null : `github:${args.resource.toLowerCase()}:${args.granteeRef.toLowerCase()}`;
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const target = parseTarget(request.resource, this.#o.allowedOwners);
    const login = request.granteeRef;
    const before = request.existingHandle ? decodeHandle(request.existingHandle) : null;
    const same = before !== null && before.grantId === request.grantId && before.login === login ? before : null;
    if (target.kind === "repo") {
      const permission = request.permission ?? "pull";
      if (!(GITHUB_PERMISSIONS as readonly string[]).includes(permission)) throw new Error(`permission ${permission} tidak dikenal`);
      const r = await call(this.#fetch, this.#base, this.#headers(), { method: "PUT", path: `/repos/${target.owner}/${target.repo}/collaborators/${login}`, body: JSON.stringify({ permission }) });
      // 201 = a new invitation; 204 = the login is a collaborator already. At the first call that means it was there before this grant (never removed at the end); at a renewal, it is what this grant gave
      const invitationId = r.status === 201 ? (JSON.parse(r.text) as { id?: number }).id ?? null : same?.invitationId ?? null;
      const preexisting = r.status === 201 ? false : same ? same.preexisting : true;
      const handle = encodeHandle({ target, login, grantId: request.grantId, invitationId, preexisting });
      return { handle, nativeExpiresAtMs: null, delivery: { provider: "github", resource: request.resource, permission, invitation: r.status === 201 ? "pending" : preexisting ? "already_collaborator" : "accepted" } };
    }
    // a seat: if the login is a member of the organization already, it stays one when the rent ends
    let preexisting = same?.preexisting ?? false;
    if (same === null) preexisting = (await call(this.#fetch, this.#base, this.#headers(), { method: "GET", path: `/orgs/${target.owner}/memberships/${login}` }, [200, 404])).status === 200;
    const r = await call(this.#fetch, this.#base, this.#headers(), { method: "PUT", path: `/orgs/${target.owner}/memberships/${login}`, body: JSON.stringify({ role: "member" }) });
    return {
      handle: encodeHandle({ target, login, grantId: request.grantId, invitationId: null, preexisting }), nativeExpiresAtMs: null,
      delivery: { provider: "github", resource: request.resource, membership: (JSON.parse(r.text) as { state?: string }).state ?? "pending", ...(preexisting ? { preexisting: true } : {}) },
    };
  }

  /** The pending invitation of `login` on a repository, found by the list (when the id was not kept), or `null`. */
  async #pendingInvitation(target: Extract<Target, { kind: "repo" }>, login: string): Promise<number | null> {
    const r = await call(this.#fetch, this.#base, this.#headers(), { method: "GET", path: `/repos/${target.owner}/${target.repo}/invitations?per_page=100` }, [200, 404]);
    if (r.status === 404) return null;
    const list = JSON.parse(r.text) as Array<{ id?: number; invitee?: { login?: string } }>;
    return list.find((i) => i.invitee?.login?.toLowerCase() === login.toLowerCase())?.id ?? null;
  }

  async revoke(handle: string): Promise<void> {
    const { target, login, invitationId, preexisting } = decodeHandle(handle);
    if (target.kind === "org") {
      if (!preexisting) await call(this.#fetch, this.#base, this.#headers(), { method: "DELETE", path: `/orgs/${target.owner}/memberships/${login}` }, [200, 204, 404]);
      return;
    }
    if (preexisting) return; // it was a collaborator before this grant: the rent does not take it away
    // cancel the invitation (the lessee may still accept it after the rent): by the id in the handle, else by the list of pending invitations
    const pending = invitationId ?? await this.#pendingInvitation(target, login);
    if (pending !== null) await call(this.#fetch, this.#base, this.#headers(), { method: "DELETE", path: `/repos/${target.owner}/${target.repo}/invitations/${pending}` }, [200, 204, 404]);
    await call(this.#fetch, this.#base, this.#headers(), { method: "DELETE", path: `/repos/${target.owner}/${target.repo}/collaborators/${login}` }, [200, 204, 404]);
  }

  async status(handle: string): Promise<AccessState> {
    const { target, login } = decodeHandle(handle);
    const path = target.kind === "org" ? `/orgs/${target.owner}/memberships/${login}` : `/repos/${target.owner}/${target.repo}/collaborators/${login}`;
    const r = await call(this.#fetch, this.#base, this.#headers(), { method: "GET", path }, [200, 204, 404]);
    if (r.status !== 404) return "active";
    // an invitation that is not accepted yet is still a way in
    return target.kind === "repo" && (await this.#pendingInvitation(target, login)) !== null ? "active" : "absent";
  }
}
