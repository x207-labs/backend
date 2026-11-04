// The catalogue of asset kinds lives in the umbrella (`scripts/lib/asset-catalog.mjs`, a plain module without a declaration file). The tests read it through this typed view,
// so that `npm run typecheck` does not need a declaration file outside this repository.
// @ts-expect-error TS7016: the module has no .d.mts; remove this line when it gets one
import { CATALOG as RAW } from "../../../scripts/lib/asset-catalog.mjs";

export interface CatalogRow {
  no: number | string;
  assetType: string;
  cls: string;
  name: string;
  delivery: string[];
  proofs?: unknown;
  status?: string;
}

export const CATALOG: CatalogRow[] = RAW as CatalogRow[];
