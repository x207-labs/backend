/**
 * One voucher pays one request at a time (security review 2). `/verify` of the facilitator reserves nothing and `/settle` answers success again to the
 * same payload, so n parallel requests with one voucher all pass `/verify`, are all served, and all settle. The broker keeps the commitment id
 * (`payer:payee:epoch:seq`) of every paid request in flight and refuses a second one with 409 `voucher_in_flight`. After `/settle` the facilitator
 * itself refuses the voucher (`seq_not_increasing`), so the guard only has to cover the time between the two.
 */
const active = new Set<string>();

function commitmentOf(header: string | null): string | undefined {
  if (header === null) return undefined;
  try {
    const voucher = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload?: { voucher?: { payer?: string; payee?: string; epoch?: number; seq?: number } } }).payload?.voucher;
    if (voucher?.payer === undefined || voucher.payee === undefined || voucher.epoch === undefined || voucher.seq === undefined) return undefined;
    return `${voucher.payer}:${voucher.payee}:${voucher.epoch}:${voucher.seq}`;
  } catch {
    return undefined;
  }
}

/** Runs `handle`; a request whose voucher is already being served gets 409. A request without a readable voucher is not guarded (the middleware answers 402). */
export async function guardVoucher(request: Request, handle: () => Promise<Response>): Promise<Response> {
  const id = commitmentOf(request.headers.get("PAYMENT-SIGNATURE"));
  if (id === undefined) return handle();
  if (active.has(id)) {
    return new Response(JSON.stringify({ error: "voucher_in_flight", message: `voucher ${id} is already paying a request` }), { status: 409, headers: { "content-type": "application/json" } });
  }
  active.add(id);
  try {
    return await handle();
  } finally {
    active.delete(id);
  }
}
