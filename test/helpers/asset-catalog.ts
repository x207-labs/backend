// The catalogue of asset kinds lives in the umbrella (`scripts/lib/asset-catalog.mjs`, a plain module without a declaration file). The tests read it through this typed view,
// so that `npm run typecheck` does not need a declaration file outside this repository.
// When the backend is cloned on its own the file is not there: CATALOG is then empty and CATALOG_MISSING holds the reason, so the tests that need it skip.
import { inUmbrella, umbrellaSkipReason } from "./umbrella.js";

export interface CatalogRow {
  no: number | string;
  assetType: string;
  cls: string;
  name: string;
  delivery: string[];
  proofs?: unknown;
  status?: string;
}

const PATH = "scripts/lib/asset-catalog.mjs";
/** null inside the umbrella; otherwise the reason the catalogue tests are skipped. */
export const CATALOG_MISSING: string | null = inUmbrella(PATH) ? null : umbrellaSkipReason(PATH);

export const CATALOG: CatalogRow[] = CATALOG_MISSING
  ? []
  // @ts-expect-error TS7016: the module has no .d.mts; remove this line when it gets one
  : ((await import("../../../scripts/lib/asset-catalog.mjs")).CATALOG as CatalogRow[]);
