// BE-077: the hashes of interface 0.0.13 as `contracts/scripts/clearing_hashes.py` defines them, for the tests only. The production code uses the functions of the SDK
// (`edgesHash`, `positionsHash`, SDK-080); this stand-in is checked against the golden vector `contracts/tests/vectors/clearing_hashes.json`.
import { createHash } from "node:crypto";
import type { ClearedEdge } from "../../src/indexer/clearing-hashes.js";

const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v), "utf8").digest("hex");

export const edgesHash = (edges: ClearedEdge[]): string =>
  sha(
    edges
      .filter((e) => BigInt(e.cleared) > 0n)
      .map((e) => ({ debtor: e.debtor, creditor: e.creditor, cleared: e.cleared }))
      .sort((a, b) => byBytes(a.debtor, b.debtor) || byBytes(a.creditor, b.creditor)),
  );

export const positionsHash = (list: unknown[]): string =>
  sha(
    (list as Array<Record<string, unknown>>)
      .map((p) => ({ account_id: p.account_id, net: p.net, role: p.role, status: p.status ?? null, amount: p.amount, outstanding_debt: p.outstanding_debt }))
      .sort((a, b) => byBytes(a.account_id as string, b.account_id as string)),
  );

export const stubHashes = { edgesHash, positionsHash };
