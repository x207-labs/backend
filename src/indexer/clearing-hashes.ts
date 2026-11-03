// BE-077: the hashes of the summary events of interface 0.0.13 (`clearing_applied.edges_hash`, `epoch_committed.positions_hash`) are the functions of the SDK
// (`edgesHash`, `positionsHash` of `@x207/core`, SDK-080): the backend has no copy of the rule. `test/helpers/clearing-hashes.ts` is an independent copy for the tests,
// checked against the golden vector `contracts/tests/vectors/clearing_hashes.json`.
import { edgesHash, positionsHash, type ClearingAppliedEdge, type EpochCommittedPosition } from "@x207/core";

/** One edge of the cleared set: only edges with `cleared > 0` are hashed. */
export type ClearedEdge = ClearingAppliedEdge;

export const clearingHashes = (): { edgesHash(edges: ClearedEdge[]): string; positionsHash(positions: EpochCommittedPosition[]): string } => ({ edgesHash, positionsHash });
