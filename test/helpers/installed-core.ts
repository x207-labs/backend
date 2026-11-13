// A few tests need an `@x207/core` newer than the one on npm (`0.0.2` carries contract interface 0.0.15; the workspace package of the umbrella carries 0.0.18 and is
// not published yet). Those tests skip, with the reason below, when the installed core reports an older interface, and run inside the umbrella, where the workspace core is linked.
import { ContractAbi } from "@x207/core";

export const INSTALLED_ABI: string = ContractAbi.X207_CIRCLE_ABI_VERSION;

const parts = (version: string): number[] => version.split(".").map((n) => Number.parseInt(n, 10) || 0);
function isOlder(version: string, than: string): boolean {
  const a = parts(version);
  const b = parts(than);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** The reason to skip a test that needs interface `needed`, or null when the installed core has it. */
export function coreTooOld(needed: string): string | null {
  return isOlder(INSTALLED_ABI, needed) ? `skipped: installed @x207/core has interface ${INSTALLED_ABI}, this test needs ${needed}; inside the umbrella the workspace core is used` : null;
}
