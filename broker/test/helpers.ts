import type { AccessGrant, AccountId, RevokeReason } from "@x207/core";
import type { BrokerChain } from "../src/chain.js";

export const GRANTOR = "scraper.x207-circle.near";
export const GRANTEE = "translator.x207-circle.near";
export const BROKER = "broker.x207-circle.near";
export const LEASE = "lease.scraper.x207-circle.near";
export const KEY = "ed25519:7YkYUwHgD8gM4tUQbkcGzMfqMPXK9RSTkUmqm9Fa8qpT";
export const SCOPE = JSON.stringify({ receiver_id: "api.x207-circle.near", method_names: ["get_data"], allowance: "250000000000000000000000" });
export const NOW = Date.parse("2026-11-05T10:00:00Z");
const NS = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();

export function grant(patch: Partial<AccessGrant> = {}): AccessGrant {
  return {
    grant_id: 1, asset_type: "near-rpc:access", grantor: GRANTOR, grantee: GRANTEE, class: "B",
    limits: { scope: SCOPE, quota: null, expires_at: NS(NOW + 10 * 86_400_000) }, unit: "day", unit_price: "250000", operator: BROKER,
    delivery_pubkey: KEY, status: "active", proof_hash: null, proof_kind: null, ...patch,
  } as AccessGrant;
}

export class FakeChain implements BrokerChain {
  readonly leaseAccount = LEASE;
  grants: Map<number, AccessGrant> = new Map<number, AccessGrant>();
  now = NOW;
  calls: string[] = [];
  keys = new Set<string>();
  revokeResult: { ok: true; txHash: string } | { ok: false; error: string } = { ok: true, txHash: "tx-revoke" };

  async getGrant(id: number): Promise<AccessGrant | null> {
    this.calls.push(`getGrant:${id}`);
    return this.grants.get(id) ?? null;
  }
  /** What the read API lists for a grantee: the ids of the active grants (the broker confirms each with `getGrant`). */
  activeIdsOf = async (account: AccountId): Promise<number[]> => [...this.grants.values()].filter((g) => g.grantee === account && g.status === "active").map((g) => g.grant_id);
  async addLeaseKey(publicKey: string, scope: string): Promise<string> {
    this.calls.push(`addKey:${publicKey}`);
    void scope;
    this.keys.add(publicKey);
    return "tx-add";
  }
  async deleteLeaseKey(publicKey: string): Promise<string> {
    this.calls.push(`deleteKey:${publicKey}`);
    this.keys.delete(publicKey);
    return "tx-delete";
  }
  async revokeGrant(id: number, reason: RevokeReason) {
    this.calls.push(`revoke:${id}:${reason}`);
    const g = this.grants.get(id);
    if (this.revokeResult.ok && g) this.grants.set(id, { ...g, status: reason === "expired" ? "expired" : "revoked" } as AccessGrant);
    return this.revokeResult;
  }
  epoch = 42;
  async currentEpoch(): Promise<number> {
    return this.epoch;
  }
  async nowMs(): Promise<number> {
    return this.now;
  }
}
