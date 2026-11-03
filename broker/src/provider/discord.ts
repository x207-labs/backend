// Discord adapter (BE-059, ADR-47 group D): a role on a server (guild) for a member, given and taken back by the bot of the grantor. `grantee_ref` is the user id (a snowflake) and must
// already be a member of the guild; `resource` is the role id. The bot token lives on the machine that runs the broker (self-hosted). A role gives no expiry of its own: the broker removes it.
import { parseGranteeProof, verifyOAuthProof, type OAuthVerifier } from "@x207/core";
import type { AccessState, ProveGranteeArgs, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, ProviderHttpError, type FetchLike } from "./http.js";

const SNOWFLAKE = /^\d{15,21}$/;

export interface DiscordOptions {
  botToken: string;
  guildId: string;
  /** Roles the broker may give; empty = any role the bot can manage. Naming them keeps a grant from pointing at an admin role. */
  allowedRoleIds?: readonly string[];
  baseUrl?: string;
  fetch?: FetchLike;
  /** Checks an OAuth token of Discord and says whose it is (`discordIdentify`). Without it the reference cannot be proven and the grant carries a warning. */
  oauth?: OAuthVerifier;
}

/** The verifier of OAuth tokens of Discord: `GET /users/@me` with the token of the user (scope `identify`); the subject is the user id. Only discord.com, a fixed host. */
export function discordIdentify(options: { baseUrl?: string; fetch?: FetchLike } = {}): OAuthVerifier {
  const base = options.baseUrl ?? "https://discord.com/api/v10";
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  return async (provider, token) => {
    if (provider !== "discord") throw new Error(`OAuth provider ${provider} is not discord`);
    const r = await call(doFetch, base, { authorization: `Bearer ${token}`, "user-agent": "x207-broker" }, { method: "GET", path: "/users/@me" }, [200]);
    const id = (JSON.parse(r.text) as { id?: unknown }).id;
    if (typeof id !== "string") throw new Error("Discord response has no id");
    return { subject: id };
  };
}

export class DiscordAdapter implements ProviderAccessAdapter {
  readonly provider = "discord";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly #o: DiscordOptions;
  readonly #base: string;
  readonly #fetch: FetchLike;

  constructor(options: DiscordOptions) {
    if (!SNOWFLAKE.test(options.guildId)) throw new Error("guildId is not a snowflake");
    this.#o = options;
    this.#base = options.baseUrl ?? "https://discord.com/api/v10";
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  #headers(): Record<string, string> {
    return { authorization: `Bot ${this.#o.botToken}`, "user-agent": "x207-broker (https://github.com/x207-labs/x207, 0.0.1)", "content-type": "application/json" };
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!SNOWFLAKE.test(ref)) return { ok: false, reason: "not a Discord user id" };
    try {
      await call(this.#fetch, this.#base, this.#headers(), { method: "GET", path: `/guilds/${this.#o.guildId}/members/${ref}` }, [200]);
      return { ok: true };
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return { ok: false, reason: "user is not a member of this server" };
      throw error;
    }
  }

  /** `oauth` (SD-071): the user id that Discord reports for the token must be the reference. With no verifier the reference cannot be proven: the grant goes on with a warning. */
  async proveGranteeRef(args: ProveGranteeArgs): Promise<boolean | { unproven: string }> {
    if (this.#o.oauth === undefined) return { unproven: "Discord OAuth is not set up on this broker: grantee_ref is only checked to exist on the server, not to belong to the renter" };
    if (args.proof === null) return false;
    const proof = parseGranteeProof(args.proof);
    if (proof.kind !== "oauth") return false;
    return verifyOAuthProof(proof, args.ref, this.#o.oauth);
  }

  #role(resource: string | null): string {
    if (resource === null || !SNOWFLAKE.test(resource)) throw new Error("resource must be a Discord role id");
    if (this.#o.allowedRoleIds && this.#o.allowedRoleIds.length > 0 && !this.#o.allowedRoleIds.includes(resource)) throw new Error("role is not in this broker's allowedRoleIds");
    return resource;
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const role = this.#role(request.resource);
    await call(this.#fetch, this.#base, this.#headers(), { method: "PUT", path: `/guilds/${this.#o.guildId}/members/${request.granteeRef}/roles/${role}` }, [204]);
    return { handle: `discord:${this.#o.guildId}:${request.granteeRef}:${role}`, nativeExpiresAtMs: null, delivery: { provider: "discord", guild: this.#o.guildId, role } };
  }

  #decode(handle: string): { user: string; role: string } {
    const m = /^discord:(\d+):(\d+):(\d+)$/.exec(handle);
    if (!m || m[1] !== this.#o.guildId) throw new Error("unknown Discord handle");
    return { user: m[2] as string, role: m[3] as string };
  }

  async revoke(handle: string): Promise<void> {
    const { user, role } = this.#decode(handle);
    await call(this.#fetch, this.#base, this.#headers(), { method: "DELETE", path: `/guilds/${this.#o.guildId}/members/${user}/roles/${role}` }, [204, 404]);
  }

  async status(handle: string): Promise<AccessState> {
    const { user, role } = this.#decode(handle);
    const r = await call(this.#fetch, this.#base, this.#headers(), { method: "GET", path: `/guilds/${this.#o.guildId}/members/${user}` }, [200, 404]);
    if (r.status === 404) return "absent";
    return (JSON.parse(r.text) as { roles?: string[] }).roles?.includes(role) ? "active" : "absent";
  }
}
