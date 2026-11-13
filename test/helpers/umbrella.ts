// A few tests read files of the x207 umbrella repository, which holds this repository as `backend/`: the asset catalogue
// (`scripts/lib/asset-catalog.mjs`) and the near-sandbox fixtures of the SDK (`sdk/test-support/`). When the backend is cloned on its own those files
// are not there. The tests that need them are then skipped with the reason below instead of failing on a missing module; inside the umbrella they run.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when `path` (relative to the umbrella root) exists, that is when the backend runs inside the umbrella. */
export function inUmbrella(path: string): boolean {
  return existsSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)));
}

/** The name of the placeholder test that a skipped file shows, so the report says why. */
export function umbrellaSkipReason(path: string): string {
  return `skipped: needs ${path} of the x207 umbrella repository, which is not there (backend cloned on its own); run inside the umbrella to include it`;
}
