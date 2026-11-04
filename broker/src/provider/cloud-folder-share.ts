// Cloud folder share adapter (BE-084, ADR-47 group B, catalog #81 `storage:shared-folder`): a generic P2 adapter for a storage provider that can share ONE folder with a person for read or write
// and can end the share at a time. The admin token of the grantor stays on the machine of the broker. A grant shares a single folder named in its scope, never the account:
//   POST   {base}/folders/{folder}/shares            {grantee, role: "reader"|"writer", expires_at}  -> 201 {id, expires_at?}
//   PUT    {base}/folders/{folder}/shares/{id}       {role, expires_at}                              -> 200   (the rent of the next day moves the end)
//   DELETE {base}/folders/{folder}/shares/{id}                                                       -> 200, 204 or 404
//   GET    {base}/folders/{folder}/shares                                                            -> 200 {shares: [{id, grantee, role, expires_at?}]}
// Scope of the grant: `resource` = the folder (segments `[A-Za-z0-9._-]` joined by `/`, no `.` or `..`), `permission` = `read` (default) or `write`, `grantee_ref` = who gets the share (an account
// name or e-mail on the provider). The folder must be one of `allowedFolders` or inside one (segment by segment): a folder outside is refused before any call. A share is not for the
// quota of the folder (the provider keeps that); the broker ends the share at the end of the paid day with `revoke` and asks the provider for the same end in `expires_at`.
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";
import { call, ProviderHttpError, type FetchLike } from "./http.js";

export interface CloudFolderShareOptions {
  /** Base URL (https) of the storage API of the grantor. */
  baseUrl: string;
  /** The admin token of the grantor. Never delivered, never logged. */
  token: string;
  /** The folders a grant may share, each with everything below it. */
  allowedFolders: readonly string[];
  now?: () => number;
  fetch?: FetchLike;
}

const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,64}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const SHARE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROLES = { read: "reader", write: "writer" } as const;

/** The folder as a list of safe segments, or `null`. */
const segmentsOf = (folder: string): string[] | null => {
  const parts = folder.split("/");
  return parts.length >= 1 && parts.length <= 12 && parts.every((p) => SEGMENT.test(p)) ? parts : null;
};
const pathOf = (segments: readonly string[]): string => segments.map(encodeURIComponent).join("/");

/** `cf:<grant id>:<folder, base64url>:<share id>`: all that `revoke` and `status` need, so a restart of the broker loses nothing. Not a secret. */
const handleOf = (grantId: number, folder: string, id: string): string => `cf:${grantId}:${Buffer.from(folder, "utf8").toString("base64url")}:${id}`;
const parseHandle = (handle: string): { folder: string; id: string } => {
  const m = /^cf:(\d+):([A-Za-z0-9_-]{1,1024}):([A-Za-z0-9_-]{1,128})$/.exec(handle);
  const folder = m ? Buffer.from(m[2] as string, "base64url").toString("utf8") : null;
  if (!m || folder === null || segmentsOf(folder) === null || !SHARE_ID.test(m[3] as string)) throw new Error("unknown cloud folder handle");
  return { folder, id: m[3] as string };
};

export class CloudFolderShareAdapter implements ProviderAccessAdapter {
  readonly provider = "cloud-folder-share";
  readonly real = true;
  readonly nativeExpiry = false;
  readonly #o: CloudFolderShareOptions;
  readonly #base: string;
  readonly #allowed: string[][];
  readonly #fetch: FetchLike;
  readonly #now: () => number;

  constructor(options: CloudFolderShareOptions) {
    if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(options.baseUrl)) throw new Error("baseUrl must be an https URL");
    if (options.token === "") throw new Error("token is required");
    if (options.allowedFolders.length === 0) throw new Error("allowedFolders is empty: name at least one folder");
    this.#allowed = options.allowedFolders.map((f) => {
      const s = segmentsOf(f);
      if (s === null) throw new Error(`allowedFolders: ${JSON.stringify(f)} is not a safe folder path`);
      return s;
    });
    this.#o = options;
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  #headers(): Record<string, string> {
    return { authorization: `Bearer ${this.#o.token}`, accept: "application/json", "content-type": "application/json", "user-agent": "x207-broker" };
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    return REF.test(ref) ? { ok: true } : { ok: false, reason: "grantee_ref is the account to share with: 1 to 128 characters [A-Za-z0-9._:@+-]" };
  }

  /** One live share of a folder for a person: a second grant for the same pair would lose its share when the first ends (B4-F2). */
  sharedKey({ granteeRef, resource }: { granteeRef: string; resource: string | null }): string | null {
    return resource === null ? null : `cloud-folder-share:${resource}:${granteeRef}`;
  }

  /** The folder and the role of a grant, checked against `allowedFolders`. */
  #terms(request: ProviderGrantRequest): { segments: string[]; folder: string; role: "reader" | "writer" } {
    const segments = segmentsOf(request.resource ?? "");
    if (segments === null) throw new Error("resource must be a folder path of segments [A-Za-z0-9._-] joined by /, without . or ..");
    const inside = this.#allowed.some((a) => a.length <= segments.length && a.every((s, i) => s === segments[i]));
    if (!inside) throw new Error(`folder ${segments.join("/")} is outside the folders this broker may share`);
    const permission = request.permission ?? "read";
    if (permission !== "read" && permission !== "write") throw new Error("permission must be read or write");
    return { segments, folder: segments.join("/"), role: ROLES[permission] };
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const { segments, folder, role } = this.#terms(request);
    const expiresAt = new Date(request.expiresAtMs).toISOString();
    const shares = `${this.#base}/folders/${pathOf(segments)}/shares`;
    // the rent of the next day: the share is there, move its end
    if (request.existingHandle) {
      const old = parseHandle(request.existingHandle);
      if (old.folder === folder) {
        const moved = await call(this.#fetch, "", this.#headers(), { method: "PUT", path: `${shares}/${old.id}`, body: JSON.stringify({ role, expires_at: expiresAt }) }, [200, 404]);
        if (moved.status === 200) return { handle: request.existingHandle, nativeExpiresAtMs: request.expiresAtMs, delivery: { provider: "cloud-folder-share", folder, role, grantee: request.granteeRef, expiresAt } };
      }
    }
    const made = await call(this.#fetch, "", this.#headers(), { method: "POST", path: shares, body: JSON.stringify({ grantee: request.granteeRef, role, expires_at: expiresAt }) }, [200, 201]);
    const body = JSON.parse(made.text) as { id?: unknown };
    if (typeof body.id !== "string" || !SHARE_ID.test(body.id)) throw new Error("the provider answered the share without a usable id");
    return { handle: handleOf(request.grantId, folder, body.id), nativeExpiresAtMs: request.expiresAtMs, delivery: { provider: "cloud-folder-share", folder, role, grantee: request.granteeRef, expiresAt } };
  }

  async revoke(handle: string): Promise<void> {
    const h = parseHandle(handle);
    await call(this.#fetch, "", this.#headers(), { method: "DELETE", path: `${this.#base}/folders/${pathOf(h.folder.split("/"))}/shares/${h.id}` }, [200, 204, 404]);
  }

  /** The list of shares of the folder: the share is `absent` when it is not in the list, `expired` when its end has passed. */
  async status(handle: string): Promise<AccessState> {
    const h = parseHandle(handle);
    let r: { status: number; text: string };
    try {
      r = await call(this.#fetch, "", this.#headers(), { method: "GET", path: `${this.#base}/folders/${pathOf(h.folder.split("/"))}/shares` }, [200]);
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) return "absent";
      throw error;
    }
    const list = (JSON.parse(r.text) as { shares?: Array<{ id?: unknown; expires_at?: unknown }> }).shares ?? [];
    const share = list.find((s) => s.id === h.id);
    if (!share) return "absent";
    const end = typeof share.expires_at === "string" ? Date.parse(share.expires_at) : NaN;
    return Number.isFinite(end) && end <= this.#now() ? "expired" : "active";
  }
}
