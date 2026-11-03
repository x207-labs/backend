// BE-077: the hashes of the summary events of interface 0.0.13 (`clearing_applied.edges_hash`, `epoch_committed.positions_hash`). The functions are the ones of the SDK
// (`edgesHash`, `positionsHash` of `@x207/core`, SDK-080): the backend has no copy of the rule. Until the SDK has them, a test sets its own with `setClearingHashes`.
import * as core from "@x207/core";
import { IndexerHaltError } from "./errors.js";

/** One edge of the cleared set: only edges with `cleared > 0` are hashed. */
export interface ClearedEdge {
  debtor: string;
  creditor: string;
  cleared: string;
}

export interface ClearingHashes {
  edgesHash(edges: ClearedEdge[]): string;
  positionsHash(positions: unknown[]): string;
}

let override: ClearingHashes | undefined;

/** For tests: use these functions instead of the SDK ones; `undefined` goes back to the SDK. */
export function setClearingHashes(hashes: ClearingHashes | undefined): void {
  override = hashes;
}

export function clearingHashes(): ClearingHashes {
  if (override) return override;
  const sdk = core as unknown as Partial<ClearingHashes>;
  if (typeof sdk.edgesHash !== "function" || typeof sdk.positionsHash !== "function") {
    throw new IndexerHaltError("@x207/core has no edgesHash/positionsHash: the SDK with interface 0.0.13 (SDK-080) is needed to read this event");
  }
  return { edgesHash: sdk.edgesHash.bind(sdk), positionsHash: sdk.positionsHash.bind(sdk) };
}
