import { appendFileSync } from "node:fs";

/** One line of the audit log. It names what happened and to which grant; it never holds a secret, a header or a body. */
export interface AuditEntry {
  at: string;
  kind: "proxy_call" | "unbilled_call" | "proxy_refused" | "secret_rotated" | "lease_closed";
  grantId?: number;
  assetType?: string;
  method?: string;
  path?: string;
  status?: number;
  /** Code of the refusal (`grant_scope_denied`, `grant_quota_exceeded`, `payer_not_grantee`, ...). */
  code?: string;
  /** Version of the secret that served the call; it counts rotations, it is not derived from the secret. */
  secretVersion?: number;
  /** For `secret_rotated`: the names of the environment variables, never their values. */
  from?: string;
  to?: string;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, "at">): void;
}

/** Entries kept in memory, for tests. */
export class MemoryAudit implements AuditLog {
  readonly entries: AuditEntry[] = [];
  record(entry: Omit<AuditEntry, "at">): void {
    this.entries.push({ at: new Date().toISOString(), ...entry });
  }
}

/** JSON lines appended to a file. Not encrypted: sealing the log to an enclave key needs the TEE that this build does not have (BK-011). */
export class FileAudit implements AuditLog {
  constructor(private readonly path: string) {}
  record(entry: Omit<AuditEntry, "at">): void {
    appendFileSync(this.path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }
}
