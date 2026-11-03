import { orderHash, serializeOrder, type OrderDocument } from "@x207/core";
import { milestoneNoticeHash as _h, serializeMilestoneNotice, type MilestoneAction, type MilestoneNotice } from "../../src/marketplace/orders.js";
import { signNoticeJson } from "../../src/marketplace/notice.js";
import { acct, CONTRACT, NOW_S, type Market } from "./helpers.js";

void _h;
export const H = (c: string): string => c.repeat(64);

export const orderDoc = (buyer: string, seller: string, over: Partial<OrderDocument> = {}): OrderDocument => ({
  circle: CONTRACT, kind: "research", buyer: acct(buyer), seller: acct(seller), spec_hash: H("a"), nonce: "n1",
  milestones: [{ amount: "10000000", due_at: NOW_S + 86_400 }, { amount: "20000000", due_at: NOW_S + 2 * 86_400 }], sample_hash: null, target: null, proof: null, ...over,
});

export const signOrder = (m: Market, doc: OrderDocument, who: string): { account: string; signature: string } => ({ account: acct(who), signature: signNoticeJson(serializeOrder(doc), CONTRACT, m.keys[who]!.secretKey) });

/** Create the order with both signatures; returns its hash. */
export async function openOrder(m: Market, doc: OrderDocument): Promise<string> {
  const res = await m.post("/orders", { order: doc, signatures: [signOrder(m, doc, doc.buyer.split(".")[0]!), signOrder(m, doc, doc.seller.split(".")[0]!)] });
  if (res.status !== 201) throw new Error(`order not created: ${JSON.stringify(res.json)}`);
  return orderHash(doc);
}

export const mnotice = (hash: string, milestone: number, actor: string, action: MilestoneAction, at: number, over: Partial<MilestoneNotice> = {}): MilestoneNotice => ({
  circle: CONTRACT, order_hash: hash, milestone, actor: acct(actor), action, at,
  deliverable_hash: action === "delivered" || action === "proposed" ? H("d") : null, reason: action === "disputed" ? "not_as_described" : null, ...over,
});

export const sendMilestone = (m: Market, hash: string, n: MilestoneNotice, signer: string = n.actor.split(".")[0]!) =>
  m.post(`/orders/${hash}/milestones/${n.milestone}`, { notice: n, signature: signNoticeJson(serializeMilestoneNotice(n), CONTRACT, m.keys[signer]!.secretKey) });
export const sendOutcome = (m: Market, hash: string, n: MilestoneNotice, signer: string = n.actor.split(".")[0]!) =>
  m.post(`/orders/${hash}/outcomes`, { notice: n, signature: signNoticeJson(serializeMilestoneNotice(n), CONTRACT, m.keys[signer]!.secretKey) });
