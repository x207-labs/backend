// On-chain proofs for the orders of the keeper (#46) and the solver (#48) (BE-055, ADR-45, spec 5f `onchain-proofs`). These two are not paid per milestone but per transaction of
// the provider that can be seen on the chain: the buyer's agent reads this list and signs one voucher per proof (`payForProofs` of the SDK).
// A proof is a call that the indexer saw, with its caller:
//   close_epoch     -> event `epoch_cutoff`
//   finalize_epoch  -> event `epoch_finalized`
//   submit_clearing -> event `clearing_submitted` (the contract names the caller in the event: `solver`)
// The caller comes from `events_raw.signer_id` (the source of blocks knows who signed the transaction) or, for `clearing_submitted`, from the field `solver` of the event. The method
// is `events_raw.method_name` when the source knew it, else the method that emits that event. A call counts when the method is the one of the order, the caller is the seller of the
// order, and it happened after the order was made. Calls of other accounts are not listed. The backend does not know which proofs were paid: the SDK keeps that (`alreadyPaid`).
import { ApiError } from "../api/errors.js";
import { rows } from "../api/format.js";
import type { Route } from "../api/router.js";
import { eventField } from "./event-data.js";
import { findOrder, syncOrders } from "./orders.js";
import { nowSeconds } from "./common.js";

/** The method of the contract whose call emits each event. */
export const PROOF_EVENT_METHOD: Readonly<Record<string, string>> = {
  epoch_cutoff: "close_epoch",
  epoch_finalized: "finalize_epoch",
  clearing_submitted: "submit_clearing",
};

interface CallRow {
  tx_hash: string;
  event: string;
  block_height: bigint;
  block_timestamp_ns: bigint;
  signer: string | null;
  method_name: string | null;
  epoch: bigint | null;
}

export const orderProofRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/orders/{hash}/onchain-proofs",
    circleScoped: true,
    handler: ({ db, circle, params, now }) => {
      syncOrders(db, circle.circle_id, nowSeconds(now()));
      const o = findOrder(db, circle.circle_id, params.hash as string);
      const doc = JSON.parse(o.order_json) as { proof: { method: string; amount_per_tx: string } | null };
      if (o.pattern !== "proof" || doc.proof === null) throw new ApiError(409, "order_not_proof_kind", `pesanan ${o.kind} tidak dibayar per bukti on-chain`, { kind: o.kind });
      const created = rows<{ ms: bigint }>(db, "SELECT created_at_ms AS ms FROM orders WHERE id = ?", o.id)[0]?.ms ?? 0n;
      const calls = rows<CallRow>(
        db,
        `SELECT tx_hash, event, block_height, block_timestamp_ns, method_name, ${eventField('epoch')} AS epoch,
                COALESCE(signer_id, CASE event WHEN 'clearing_submitted' THEN ${eventField('solver')} END) AS signer
           FROM events_raw
          WHERE contract_id = ? AND tx_hash IS NOT NULL AND event IN ('epoch_cutoff','epoch_finalized','clearing_submitted') AND block_timestamp_ns >= ?
          ORDER BY block_height, receipt_id, log_index`,
        circle.contract_id, created * 1_000_000n,
      );
      const seen = new Set<string>();
      const items = [];
      for (const c of calls) {
        const method = c.method_name ?? PROOF_EVENT_METHOD[c.event];
        if (method !== doc.proof.method || c.signer !== o.seller || seen.has(c.tx_hash)) continue;
        seen.add(c.tx_hash);
        items.push({
          txHash: c.tx_hash, method, signer: c.signer, blockHeight: Number(c.block_height), epoch: c.epoch === null ? null : Number(c.epoch),
          at: new Date(Number(c.block_timestamp_ns / 1_000_000n)).toISOString().replace(/\.\d{3}Z$/, "Z"),
        });
      }
      return {
        status: 200,
        body: {
          orderHash: o.order_hash, kind: o.kind, method: doc.proof.method, seller: o.seller, amountPerTx: doc.proof.amount_per_tx, budget: o.budget,
          maxProofs: Number(BigInt(o.budget) / BigInt(doc.proof.amount_per_tx)), unit: "credit", decimals: 6, items,
        },
      };
    },
  },
];
