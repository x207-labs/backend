// Claims of the votes of a `delegate` order (BE-055 fix, SD-072, docs/delegate-claims.md). A vote is a call to the DAO (`act_proposal`), not an event of the circle, so the indexer
// does not see it: the seller claims each transaction with a signed notice and the backend checks it once through the RPC it is configured with (never an address from a user).
// A claim holds when the transaction succeeded, was signed by the seller, went to the DAO of the mandate, is one `act_proposal` with `VoteApprove` or `VoteReject`, comes after the
// order was made, and the proposal is of a kind of the mandate. A proposal is claimed once per order and a transaction once per circle.
import type Database from "better-sqlite3";
import { DELEGATE_VOTE_ACTIONS, OrderError, orderClaimNotice, type DelegateMandate, type OrderClaimNotice } from "@x207/core";
import { ApiError, invalidRequest } from "../api/errors.js";
import { row } from "../api/format.js";
import type { Route } from "../api/router.js";
import type { ViewFunction } from "../settlement/intents.js";
import { activeMemberKey } from "./auth.js";
import { nowSeconds } from "./common.js";
import { NOTICE_SKEW_SECONDS, verifyNoticeJson } from "./notice.js";
import { asApiError, findOrder, syncOrders } from "./orders.js";

export const CLAIM_REASONS = ["tx_not_found", "tx_failed", "wrong_signer", "wrong_receiver", "not_a_vote", "kind_not_in_mandate", "already_claimed", "before_order"] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

/** What the backend needs from the chain for a claim; production uses the RPC of the node, tests a mock. */
export interface ClaimRpc {
  /** Result of the RPC `tx` (final) for the transaction; `null` when the node does not know it. */
  tx(txHash: string, signer: string): Promise<unknown | null>;
  /** Timestamp in nanoseconds of the block with this hash. */
  blockTimestampNs(blockHash: string): Promise<bigint>;
}

export interface ClaimOptions {
  claimRpc?: ClaimRpc;
}

/** `ClaimRpc` over JSON-RPC `tx` and `block` of one node. */
export function jsonRpcClaimRpc(rpcUrl: string, fetchImpl: typeof fetch = fetch): ClaimRpc {
  const call = async (method: string, params: unknown): Promise<{ result?: unknown; error?: { cause?: { name?: string } } }> => {
    const res = await fetchImpl(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x207", method, params }) });
    return (await res.json()) as { result?: unknown; error?: { cause?: { name?: string } } };
  };
  return {
    async tx(txHash, signer) {
      const out = await call("tx", { tx_hash: txHash, sender_account_id: signer, wait_until: "FINAL" });
      if (out.result !== undefined) return out.result;
      const name = out.error?.cause?.name;
      if (name === "UNKNOWN_TRANSACTION" || name === "TIMEOUT_ERROR") return null;
      throw new Error(`rpc tx: ${JSON.stringify(out.error ?? out)}`);
    },
    async blockTimestampNs(blockHash) {
      const out = await call("block", { block_id: blockHash });
      const ts = (out.result as { header?: { timestamp_nanosec?: string } } | undefined)?.header?.timestamp_nanosec;
      if (typeof ts !== "string") throw new Error("rpc block: no timestamp");
      return BigInt(ts);
    },
  };
}

const invalid = (reason: ClaimReason, message: string, details: Record<string, unknown> = {}): never => {
  throw new ApiError(400, "claim_invalid", message, { reason, ...details });
};

const isFailure = (status: unknown): boolean => status !== null && typeof status === "object" && "Failure" in (status as object);
const snake = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** `kind` of a Sputnik proposal: a name (`"Vote"`) or an object with one key (`{"Transfer": {...}}`), as snake_case. */
export function proposalKindName(kind: unknown): string | null {
  if (typeof kind === "string") return snake(kind);
  if (kind !== null && typeof kind === "object") {
    const keys = Object.keys(kind as object);
    if (keys.length === 1) return snake(keys[0] as string);
  }
  return null;
}

export function orderClaimRoutes(chainView: ViewFunction | undefined, options: ClaimOptions = {}): Route[] {
  return [
    {
      method: "POST",
      pattern: "/x207/circles/{circle}/orders/{hash}/claims",
      circleScoped: true,
      handler: async ({ db, circle, params, body, now }) => {
        syncOrders(db, circle.circle_id, nowSeconds(now()));
        const o = findOrder(db, circle.circle_id, params.hash as string);
        if (o.kind !== "delegate" || o.mandate_json === null) throw new ApiError(409, "order_not_proof_kind", `pesanan ${o.kind} tidak punya klaim suara`, { kind: o.kind });
        if (body === null || typeof body !== "object") throw invalidRequest("body harus objek");
        const { tx_hash: txHashField, notice, signature } = body as { tx_hash?: unknown; notice?: unknown; signature?: unknown };
        if (typeof signature !== "string") throw invalidRequest("signature wajib string");
        if (notice === null || typeof notice !== "object") throw invalidRequest("notice wajib objek");
        const n = notice as OrderClaimNotice;
        let canonical: OrderClaimNotice;
        try {
          if (n.action !== "claim") throw new OrderError("order_bad_state", "action notice klaim harus claim");
          canonical = orderClaimNotice({ circle: n.circle, orderHash: n.order_hash, actor: n.actor, at: n.at, txHash: n.tx_hash });
        } catch (error) {
          return asApiError(error);
        }
        if (typeof txHashField === "string" && txHashField !== canonical.tx_hash) throw invalidRequest("tx_hash harus sama dengan notice.tx_hash");
        if (canonical.circle !== circle.contract_id) throw invalidRequest("notice.circle harus akun kontrak lingkaran", { expected: circle.contract_id, got: canonical.circle });
        if (canonical.order_hash !== o.order_hash) throw invalidRequest("notice.order_hash harus hash pesanan ini");
        const nowS = nowSeconds(now());
        if (Math.abs(canonical.at - nowS) > NOTICE_SKEW_SECONDS) throw invalidRequest(`notice.at menyimpang lebih dari ${NOTICE_SKEW_SECONDS} detik dari jam server`, { at: canonical.at, now: nowS });
        if (canonical.actor !== o.seller) throw new ApiError(403, "order_not_party", "Hanya penjual (delegate) yang mengklaim suara", { actor: canonical.actor });
        const json = JSON.stringify(canonical);
        if (!verifyNoticeJson(json, circle.contract_id, signature, activeMemberKey(db, circle.circle_id, canonical.actor))) {
          throw new ApiError(401, "invalid_signature", "Tanda tangan notice tidak cocok dengan kunci voucher anggota", { account: canonical.actor });
        }
        if (o.status !== "open") throw new ApiError(409, "order_bad_state", `pesanan belum terbuka (keadaan ${o.status}): kedua pihak harus menandatangani`, { status: o.status });
        const rpc = options.claimRpc;
        if (rpc === undefined) throw new ApiError(503, "claim_rpc_unavailable", "RPC untuk memeriksa klaim belum dikonfigurasi", {});
        const mandate = JSON.parse(o.mandate_json) as DelegateMandate;
        const order = JSON.parse(o.order_json) as { proof: { method: string } };
        const txHash = canonical.tx_hash;

        if (row(db, "SELECT 1 AS x FROM order_claims WHERE circle_id = ? AND tx_hash = ?", circle.circle_id, txHash) !== undefined) invalid("already_claimed", "transaksi ini sudah diklaim", { tx_hash: txHash });

        // 1. the transaction exists and every step of it succeeded
        const tx = (await rpc.tx(txHash, o.seller)) as {
          status?: unknown;
          transaction?: { signer_id?: string; receiver_id?: string; actions?: Array<{ FunctionCall?: { method_name?: string; args?: string } }> };
          transaction_outcome?: { block_hash?: string };
          receipts_outcome?: Array<{ outcome?: { status?: unknown } }>;
        } | null;
        if (tx === null || tx === undefined || typeof tx !== "object" || tx.transaction === undefined) return invalid("tx_not_found", "transaksi tidak dikenal oleh RPC", { tx_hash: txHash });
        if (isFailure(tx.status) || (tx.receipts_outcome ?? []).some((r) => isFailure(r.outcome?.status)) || tx.status === undefined) invalid("tx_failed", "transaksi gagal", { tx_hash: txHash });
        // 2. signer and receiver
        if (tx.transaction.signer_id !== o.seller) invalid("wrong_signer", "transaksi tidak ditandatangani penjual", { signer: tx.transaction.signer_id ?? null });
        if (tx.transaction.receiver_id !== mandate.dao) invalid("wrong_receiver", "transaksi tidak ke DAO dalam mandat", { receiver: tx.transaction.receiver_id ?? null, dao: mandate.dao });
        // 3. one act_proposal that is a vote
        const actions = tx.transaction.actions ?? [];
        const call = actions.length === 1 ? actions[0]?.FunctionCall : undefined;
        if (call === undefined || call.method_name !== order.proof.method) invalid("not_a_vote", "transaksi bukan satu panggilan ke method suara pesanan ini", { method: call?.method_name ?? null });
        let args: { id?: unknown; action?: unknown };
        try {
          args = JSON.parse(Buffer.from(call!.args ?? "", "base64").toString("utf8")) as { id?: unknown; action?: unknown };
        } catch {
          return invalid("not_a_vote", "argumen panggilan bukan JSON");
        }
        if (typeof args.action !== "string" || !DELEGATE_VOTE_ACTIONS.includes(args.action) || !Number.isSafeInteger(args.id) || (args.id as number) < 0) {
          invalid("not_a_vote", "hanya VoteApprove dan VoteReject yang dibayar", { action: typeof args.action === "string" ? args.action : null });
        }
        const proposalId = args.id as number;
        const action = args.action as string;
        // 4. after the order was made
        const created = row<{ ms: bigint }>(db, "SELECT created_at_ms AS ms FROM orders WHERE id = ?", o.id)?.ms ?? 0n;
        const blockHash = tx.transaction_outcome?.block_hash;
        if (typeof blockHash !== "string") return invalid("tx_not_found", "RPC tidak memberi blok transaksi", { tx_hash: txHash });
        if ((await rpc.blockTimestampNs(blockHash)) < created * 1_000_000n) invalid("before_order", "suara ini diberikan sebelum pesanan dibuat", { tx_hash: txHash });
        // 5. the proposal is of a kind of the mandate (the kind never changes, so it is read once)
        if (row(db, "SELECT 1 AS x FROM order_claims WHERE circle_id = ? AND order_hash = ? AND proposal_id = ?", circle.circle_id, o.order_hash, proposalId) !== undefined) {
          invalid("already_claimed", "proposal ini sudah diklaim untuk pesanan ini", { proposal_id: proposalId });
        }
        let kind = row<{ kind: string }>(db, "SELECT kind FROM order_proposal_kinds WHERE dao = ? AND proposal_id = ?", mandate.dao, proposalId)?.kind ?? null;
        if (kind === null) {
          if (chainView === undefined) throw new ApiError(503, "claim_rpc_unavailable", "view RPC untuk jenis proposal belum dikonfigurasi", {});
          const proposal = (await chainView(mandate.dao, "get_proposal", { id: proposalId })) as { kind?: unknown } | null;
          kind = proposalKindName(proposal?.kind);
          if (kind === null) return invalid("kind_not_in_mandate", "jenis proposal tidak terbaca", { proposal_id: proposalId });
          db.prepare("INSERT OR IGNORE INTO order_proposal_kinds (dao, proposal_id, kind) VALUES (?, ?, ?)").run(mandate.dao, proposalId, kind);
        }
        if (!mandate.kinds.includes(kind)) invalid("kind_not_in_mandate", "jenis proposal di luar mandat", { proposal_id: proposalId, proposal_kind: kind, allowed: mandate.kinds });

        db.prepare(
          `INSERT INTO order_claims (circle_id, order_hash, proposal_id, tx_hash, signer, receiver, action, proposal_kind, notice_json, signature, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(circle.circle_id, o.order_hash, proposalId, txHash, o.seller, mandate.dao, action, kind, json, signature, now());
        return { status: 201, body: { orderHash: o.order_hash, txHash, method: order.proof.method, signer: o.seller, receiver: mandate.dao, proposalId, action, proposalKind: kind } };
      },
    },
  ];
}

