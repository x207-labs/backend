/** BE-077: every obligation of an epoch with its `cleared`, read from the view `list_obligations` page by page (final block). */
export async function viewClearedEdges(rpcUrl: string, contractId: string, epoch: number): Promise<Array<{ debtor: string; creditor: string; cleared: string }>> {
  const limit = 100;
  const edges: Array<{ debtor: string; creditor: string; cleared: string }> = [];
  for (let from = 0; ; from += limit) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "x207", method: "query",
        params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: "list_obligations", args_base64: Buffer.from(JSON.stringify({ epoch, from_index: from, limit })).toString("base64") },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as { result?: { result: number[] }; error?: unknown };
    if (!body.result) throw new Error(`list_obligations failed: ${JSON.stringify(body.error)}`);
    const page = JSON.parse(Buffer.from(body.result.result).toString("utf8")) as Array<{ debtor: string; creditor: string; cleared: string }>;
    for (const o of page) edges.push({ debtor: o.debtor, creditor: o.creditor, cleared: o.cleared });
    if (page.length < limit) return edges;
  }
}
