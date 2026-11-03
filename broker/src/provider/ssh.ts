// SSH adapter (BE-058, ADR-47): a line in `authorized_keys` on the machine of the grantor. No account of a provider and no API: the machine itself is the provider.
//   restrict,command="<forced command>",expiry-time="YYYYMMDDHHMMSSZ" ssh-ed25519 AAAA… x207-grant-<id>
// `restrict` turns off port, agent and X11 forwarding and the pty; `command=` is the only thing the key may run; `expiry-time=` makes sshd itself refuse the key after the paid end, so
// the access closes even if the broker is down (native expiry). The line carries the comment `x207-grant-<id>`: that is the handle, and the only thing `revoke` removes.
// The broker writes this file, so this adapter runs on the machine of the grantor only (self-hosted); it counts as `real`.
import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { AccessState, ProviderAccessAdapter, ProviderGrantRequest, ProviderGrantResult } from "./adapter.js";

/** Where the lines are kept. The default writes a file; tests keep it in memory. */
export interface AuthorizedKeysFile {
  read(): Promise<string>;
  write(content: string): Promise<void>;
}

export const fileAuthorizedKeys = (path: string): AuthorizedKeysFile => ({
  read: async () => readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? "" : Promise.reject(e))),
  // write beside and rename, so sshd never reads a half-written file
  write: async (content) => {
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, path);
  },
});

const KEY_TYPES: Readonly<Record<string, { blob: string; length?: number }>> = {
  "ssh-ed25519": { blob: "ssh-ed25519", length: 51 },
  "ecdsa-sha2-nistp256": { blob: "ecdsa-sha2-nistp256" },
  "ecdsa-sha2-nistp384": { blob: "ecdsa-sha2-nistp384" },
  "sk-ssh-ed25519@openssh.com": { blob: "sk-ssh-ed25519@openssh.com" },
  "ssh-rsa": { blob: "ssh-rsa" },
};

/** A public key of the form `<type> <base64>`; the blob must start with the same type name, so an option cannot ride in the type field. Returns the clean `type base64` or a reason. */
export function parsePublicKey(ref: string): { ok: true; key: string } | { ok: false; reason: string } {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(ref.trim())) return { ok: false, reason: "kunci tidak boleh memuat baris baru atau karakter kontrol" };
  const parts = ref.trim().split(/\s+/);
  const type = parts[0] ?? "";
  const known = KEY_TYPES[type];
  if (!known) return { ok: false, reason: `jenis kunci ${JSON.stringify(type.slice(0, 40))} tidak didukung` };
  const b64 = parts[1] ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length > 2048) return { ok: false, reason: "bagian base64 kunci tidak sah" };
  const blob = Buffer.from(b64, "base64");
  const nameLength = blob.length >= 4 ? blob.readUInt32BE(0) : -1;
  if (nameLength < 1 || 4 + nameLength > blob.length || blob.subarray(4, 4 + nameLength).toString("latin1") !== known.blob) return { ok: false, reason: "isi kunci tidak cocok dengan jenisnya" };
  if (known.length !== undefined && blob.length !== known.length) return { ok: false, reason: "panjang kunci ed25519 tidak sah" };
  return { ok: true, key: `${type} ${b64}` };
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** `YYYYMMDDHHMMSSZ` in UTC, the form of `expiry-time=`. */
export function sshTimespec(ms: number): string {
  const d = new Date(Math.floor(ms / 1000) * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
export function parseTimespec(spec: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(spec);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null;
}

/** The forced command goes between double quotes of an option: no quote, backslash, control character or newline. */
export function commandProblem(command: string): string | null {
  if (command.length === 0 || command.length > 512) return "command harus 1 sampai 512 karakter";
  if (/["\\\x00-\x1f\x7f]/.test(command)) return "command tidak boleh memuat tanda kutip ganda, backslash, atau karakter kontrol";
  return null;
}

const marker = (grantId: number): string => `x207-grant-${grantId}`;

export interface SshAdapterOptions {
  file: AuthorizedKeysFile;
  now?: () => number;
  /** The command that a key may run when the grant names none (`resource`). Default: a refusal, so a grant without a command opens nothing. */
  defaultCommand?: string;
}

export class SshAdapter implements ProviderAccessAdapter {
  readonly provider = "ssh";
  readonly real = true;
  readonly nativeExpiry = true;
  readonly #o: SshAdapterOptions;
  readonly #now: () => number;
  /** Writes of one file run one after the other: two grants must not overwrite each other's line. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: SshAdapterOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
  }

  async verifyGranteeRef(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = parsePublicKey(ref);
    return parsed.ok ? { ok: true } : parsed;
  }

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn);
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async grant(request: ProviderGrantRequest): Promise<ProviderGrantResult> {
    const parsed = parsePublicKey(request.granteeRef);
    if (!parsed.ok) throw new Error(parsed.reason);
    const command = request.resource ?? this.#o.defaultCommand ?? null;
    if (command === null) throw new Error("grant SSH wajib menamai command di resource");
    const problem = commandProblem(command);
    if (problem !== null) throw new Error(problem);
    const handle = marker(request.grantId);
    const line = `restrict,command="${command}",expiry-time="${sshTimespec(request.expiresAtMs)}" ${parsed.key} ${handle}`;
    await this.#locked(async () => {
      const lines = (await this.#o.file.read()).split("\n").filter((l) => l !== "" && !l.endsWith(` ${handle}`));
      await this.#o.file.write(`${[...lines, line].join("\n")}\n`);
    });
    return { handle, nativeExpiresAtMs: Math.floor(request.expiresAtMs / 1000) * 1000, delivery: { host_key_command: command, expiresAt: new Date(Math.floor(request.expiresAtMs / 1000) * 1000).toISOString() } };
  }

  async revoke(handle: string): Promise<void> {
    await this.#locked(async () => {
      const text = await this.#o.file.read();
      const lines = text.split("\n").filter((l) => l !== "");
      const kept = lines.filter((l) => !l.endsWith(` ${handle}`));
      if (kept.length !== lines.length) await this.#o.file.write(kept.length === 0 ? "" : `${kept.join("\n")}\n`);
    });
  }

  async status(handle: string): Promise<AccessState> {
    const line = (await this.#o.file.read()).split("\n").find((l) => l.endsWith(` ${handle}`));
    if (!line) return "absent";
    const expiry = /expiry-time="(\d{14}Z)"/.exec(line)?.[1];
    const at = expiry === undefined ? null : parseTimespec(expiry);
    return at !== null && this.#now() >= at ? "expired" : "active";
  }
}

/**
 * What sshd does with the file, for the tests: does it let `publicKey` in at `nowMs`, and with which options? A line is used only if its key matches and its `expiry-time` has not
 * passed. Written here so that the claim "the key closes by itself" is tested against the line the adapter writes, not against the adapter's own `status`.
 */
export function sshdAccepts(authorizedKeys: string, publicKey: string, nowMs: number): { accepted: boolean; options: string | null } {
  const wanted = parsePublicKey(publicKey);
  if (!wanted.ok) return { accepted: false, options: null };
  for (const line of authorizedKeys.split("\n")) {
    const at = line.indexOf(wanted.key);
    if (at === -1) continue;
    const options = line.slice(0, at).trim();
    const expiry = /expiry-time="(\d{14}Z)"/.exec(options)?.[1];
    const expiresAt = expiry === undefined ? null : parseTimespec(expiry);
    if (expiresAt !== null && nowMs >= expiresAt) continue;
    return { accepted: true, options };
  }
  return { accepted: false, options: null };
}
