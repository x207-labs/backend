/**
 * Open grants of a grantee from the read API of M6 (`GET /x207/circles/{circle}/grants?grantee=&status=active`), followed through its cursor.
 * The broker reads this list and not the `grants_of` view of the contract, so a long history of one account does not cost a view call
 * (security review F5). The caller still confirms each id with `get_grant` before acting.
 */
export interface ActiveGrantsOptions {
  readApiUrl: string;
  circle: string;
  fetch?: typeof fetch;
  pageSize?: number;
}

export function activeGrantIdsOf(options: ActiveGrantsOptions): (grantee: string) => Promise<number[]> {
  return async (grantee) => {
    const base = options.readApiUrl.replace(/\/+$/, "");
    const ids: number[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `${base}/x207/circles/${encodeURIComponent(options.circle)}/grants?grantee=${encodeURIComponent(grantee)}&status=active&limit=${options.pageSize ?? 100}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`read API ${response.status} untuk ${url}`);
      const page = (await response.json()) as { items: Array<{ grantId: number }>; nextCursor: string | null };
      for (const item of page.items) ids.push(item.grantId);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return ids;
  };
}
