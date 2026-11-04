// Demo data for the jury (BE-080): one example of every pipeline that runs, posted to a backend through its own API, so that the pages show a market with something in it.
// Nothing here is a secret and nothing is stored in the repository: the keys of the demo accounts come from the seed string that the operator keeps outside it (`X207_DEMO_SEED`), and the
// accounts must be members of the circle with the public keys that `demoKeys` gives (`--print-members` of `scripts/demo-seed.mjs` prints them). The issuer of the codes and the provider of
// the access are the mocks of the backend and the broker. The run is idempotent: every object has a fixed content (fixed names, nonces, dates), so the hash is the same each time, and the
// backend answers "already exists" for what is there. Posted: class A listings (batch 1), P2 access rent, P3 one-time code, P4 transfers, P5 job, P6 order, P7 license, P8 invoice.
import { createHash } from "node:crypto";
import {
  buildAssetTemplate, codeDocumentHash, contentHash, encryptCode, invoiceHash, licenseDocumentHash, orderHash, serializeOrder, signListing, voucherPublicKey,
  type CodeDocument, type InvoiceDocument, type Listing, type LicenseDocument, type OrderDocument,
} from "@x207/core";
import { serializeInvoiceNotice, type InvoiceNotice } from "../marketplace/invoices.js";
import { signNoticeJson } from "../marketplace/notice.js";
import { transferDocumentHash, type TransferDocument } from "../marketplace/transfer-types.js";

export interface DemoClient {
  get(path: string): Promise<{ status: number; json: any }>;
  post(path: string, body: unknown): Promise<{ status: number; json: any }>;
}
export interface DemoKey {
  secretKey: Uint8Array;
  publicKey: string;
}
export type DemoRole = "seller" | "buyer" | "helper";
export interface DemoOptions {
  /** Account of the circle contract (the `circle` of every document). */
  circleContract: string;
  /** The three demo accounts, by role. */
  accounts: Record<DemoRole, string>;
  keys: Record<DemoRole, DemoKey>;
  /** Unix seconds of now; only the notices that the backend wants fresh use it, never the hash of an object. */
  nowS: number;
  /** Fixed end of every listing and milestone anchor (unix seconds); the same value each run keeps the hashes the same. */
  expiresAt: number;
  /** A domain listing needs the TXT `x207-sell=<listing_hash>` on the domain: off by default. */
  domain?: string;
}
export type SeedOutcome = "created" | "exists" | "skipped" | "failed";
export interface SeedResult {
  pipeline: string;
  item: string;
  outcome: SeedOutcome;
  detail?: string;
}

/** The demo keys: the secret of an account is `sha256(seed ‖ role)`, so the same seed always gives the same accounts and nothing needs to be stored. */
export function demoKeys(seed: string): Record<DemoRole, DemoKey> {
  if (seed.length < 16) throw new Error("the demo seed must be at least 16 characters (X207_DEMO_SEED)");
  const make = (role: DemoRole): DemoKey => {
    const secretKey = createHash("sha256").update(`x207-demo-seed\u0000${seed}\u0000${role}`, "utf8").digest();
    return { secretKey: new Uint8Array(secretKey), publicKey: voucherPublicKey(new Uint8Array(secretKey)) };
  };
  return { seller: make("seller"), buyer: make("buyer"), helper: make("helper") };
}

const C = (n: number): string => (BigInt(n) * 1_000_000n).toString();
const hex64 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const EXISTS = new Set(["already_exists", "order_duplicate", "invoice_duplicate"]);

/** Post everything; never throws for a refusal of the backend, which is reported in the result. */
export async function seedDemo(client: DemoClient, o: DemoOptions): Promise<SeedResult[]> {
  const results: SeedResult[] = [];
  const seller = o.accounts.seller;
  const buyer = o.accounts.buyer;
  const listing = (over: Partial<Listing> & Pick<Listing, "offer" | "nonce">): { listing: Listing; signature: string } => {
    const l: Listing = {
      circle: o.circleContract, account: seller, want: { asset_type: "usdc", asset_class: "A", quantity: 1, value: over.offer.value }, terms: "Demo listing for the jury: made by scripts/demo-seed, safe to ignore.",
      detail: "", expires_at: o.expiresAt, discount_bps: 0, accept_payment: true, discoverable: true, ...over,
    };
    return { listing: l, signature: signListing(l, o.keys.seller.secretKey) };
  };
  const record = (pipeline: string, item: string, r: { status: number; json: any }): void => {
    const code = r.json?.error?.code as string | undefined;
    if (r.status === 200 || r.status === 201) results.push({ pipeline, item, outcome: "created" });
    else if (r.status === 409 && code !== undefined && EXISTS.has(code)) results.push({ pipeline, item, outcome: "exists" });
    else results.push({ pipeline, item, outcome: "failed", detail: `${r.status} ${code ?? ""} ${String(r.json?.error?.message ?? "").slice(0, 160)}`.trim() });
  };
  const postListing = async (pipeline: string, item: string, body: { listing: Listing; signature: string }): Promise<void> => {
    try {
      record(pipeline, item, await client.post("/listings", body));
    } catch (error) {
      results.push({ pipeline, item, outcome: "failed", detail: (error as Error).message.slice(0, 160) });
    }
  };

  // the three accounts must be members with the demo keys, or every signature is refused: say so once, with the key that is expected
  for (const role of ["seller", "buyer", "helper"] as const) {
    const m = await client.get(`/members/${o.accounts[role]}`).catch(() => ({ status: 0, json: null }));
    const registered = m.json?.pubkeyVoucher;
    if (m.status !== 200) results.push({ pipeline: "members", item: role, outcome: "failed", detail: `${o.accounts[role]} is not a member of this circle; join with the voucher key ${o.keys[role].publicKey}` });
    else if (registered !== undefined && registered !== o.keys[role].publicKey) results.push({ pipeline: "members", item: role, outcome: "failed", detail: `${o.accounts[role]} is a member with another voucher key than the demo seed gives` });
  }
  if (results.some((r) => r.pipeline === "members")) return results;

  // batch 1, class A: an NFT and a fungible token (the asset types must be registered as class A in the registry D10 of the circle)
  for (const [item, input] of [
    ["nft:nep171", { kind: "nft", name: "Demo art piece", nftContract: "demo-art.testnet", tokenId: "1", unitPrice: C(25), expiresAt: o.expiresAt }],
    ["token:nep141", { kind: "ft", ftContract: "usdt.x207-deployer.testnet", amount: "1000000", decimals: 6, symbol: "USDT", unitPrice: C(1), expiresAt: o.expiresAt }],
  ] as const) {
    const t = buildAssetTemplate(input as never, o.nowS);
    await postListing("class A", item, listing({ offer: { asset_type: t.assetType, asset_class: "A", quantity: 1, value: input.unitPrice }, detail: t.detail, nonce: `demo-a-${item.replace(/[^a-z0-9]+/g, "-")}` }));
  }

  // P2, rent of an access: a class B listing; the broker serves it with the mock provider
  await postListing("P2 access rent", "near-rpc:access", listing({
    offer: { asset_type: "near-rpc:access", asset_class: "B", quantity: 1, value: C(2) }, nonce: "demo-p2-access",
    detail: "Rent a limited function-call access for one day, paid per day. The demo broker uses a mock provider.",
  }));

  // P3, one-time code: the code is a fixed demo string; the issuer "demo-issuer" is the mock issuer of the backend (X207_CODE_MOCK_ISSUER)
  const salt = new Uint8Array(createHash("sha256").update(`x207-demo-code-salt\u0000${hex64(o.keys.seller.publicKey)}`).digest());
  const enc = encryptCode("DEMO-GIFT-0001", { salt });
  const codeDoc: CodeDocument = { circle: o.circleContract, seller, code_commitment: enc.code_commitment, issuer: "demo-issuer", value: C(10), verifiable: true, arbiter: null, nonce: "demo-code-1" };
  await postListing("P3 one-time code", "demo gift code", listing({
    offer: { asset_type: "data:dataset", asset_class: "B", quantity: 1, value: codeDoc.value }, nonce: "demo-p3-code",
    detail: JSON.stringify({ kind: "code", code_doc: codeDocumentHash(codeDoc), code_commitment: codeDoc.code_commitment, issuer: codeDoc.issuer, verifiable: codeDoc.verifiable, arbiter: codeDoc.arbiter, nonce: codeDoc.nonce }),
  }));

  // P4, transfer through the platform: a game item (Steam trade offer) and a ticket (confirmed by the buyer); a domain only when the operator set the TXT
  const transfers: Array<{ item: string; platform: TransferDocument["platform"]; ref: string; value: number }> = [
    { item: "game item", platform: "game_item", ref: "730:1000000001", value: 12 },
    { item: "ticket", platform: "ticket", ref: "demo-ticket-0001", value: 30 },
    ...(o.domain === undefined ? [] : [{ item: "domain", platform: "domain" as const, ref: o.domain, value: 40 }]),
  ];
  if (o.domain === undefined) results.push({ pipeline: "P4 transfer", item: "domain", outcome: "skipped", detail: "a domain listing needs the TXT x207-sell=<listing_hash> on a domain you control; pass --domain" });
  for (const t of transfers) {
    const method = t.platform === "domain" ? "dns_txt" : t.platform === "game_item" ? "trade_api" : "buyer_confirm";
    const doc: TransferDocument = { circle: o.circleContract, seller, platform: t.platform, transfer_ref: t.ref, proof_method: method, estimate_seconds: 600, value: C(t.value), nonce: `demo-p4-${t.platform}` };
    await postListing("P4 transfer", t.item, listing({
      offer: { asset_type: t.platform === "domain" ? "transfer:domain" : t.platform === "game_item" ? "transfer:game-item" : "transfer:ticket", asset_class: "B", quantity: 1, value: doc.value }, nonce: `demo-p4-${t.platform}`,
      detail: JSON.stringify({ kind: "transfer", transfer_doc: transferDocumentHash(doc), platform: doc.platform, transfer_ref: doc.transfer_ref, proof_method: doc.proof_method, estimate_seconds: doc.estimate_seconds, nonce: doc.nonce }),
    }));
  }

  // P5, job: a metered resource (class D), a job paid per call to a mock endpoint
  await postListing("P5 job", "compute:gpu-hours", listing({
    offer: { asset_type: "compute:gpu-hours", asset_class: "D", quantity: 10, value: C(20) }, nonce: "demo-p5-job",
    detail: JSON.stringify({ unit: "job", unit_price: C(2), endpoint: "https://api.provider.example/v1/run" }),
  }));

  // P6, order: research work in two milestones, signed by both parties
  const order: OrderDocument = {
    circle: o.circleContract, kind: "research", buyer, seller, spec_hash: hex64("demo research order: summarize five papers"), nonce: "demo-p6-order",
    milestones: [{ amount: C(10), due_at: o.expiresAt - 20 * 86_400 }, { amount: C(20), due_at: o.expiresAt - 10 * 86_400 }], sample_hash: null, target: null, proof: null,
  };
  try {
    const sign = (who: DemoRole) => ({ account: o.accounts[who], signature: signNoticeJson(serializeOrder(order), o.circleContract, o.keys[who].secretKey) });
    record("P6 order", `order ${orderHash(order).slice(0, 8)}`, await client.post("/orders", { order, signatures: [sign("buyer"), sign("seller")] }));
  } catch (error) {
    results.push({ pipeline: "P6 order", item: "research order", outcome: "failed", detail: (error as Error).message.slice(0, 160) });
  }

  // P7, license: the listing of a dataset; the file itself stays with the seller (the plain text here is the demo file)
  const plain = new TextEncoder().encode("id,name\n1,alpha\n2,beta\n3,gamma\n");
  const licenseDoc: LicenseDocument = {
    circle: o.circleContract, seller, content_hash: contentHash(plain), license_id: "commercial", license_hash: hex64("demo terms of the license"), preview_hash: null, exclusive: false, nonce: "demo-p7-license",
  };
  await postListing("P7 license", "demo dataset", listing({
    offer: { asset_type: "data:dataset", asset_class: "B", quantity: 1, value: C(50) }, nonce: "demo-p7-license",
    detail: JSON.stringify({ kind: "license", asset_type: "data:dataset", license_doc: licenseDocumentHash(licenseDoc), content_hash: licenseDoc.content_hash, license_id: licenseDoc.license_id, license_hash: licenseDoc.license_hash, exclusive: false }),
  }));

  // P8, invoice: the issuer asks for 60 credit in three installments; the debtor approves in the page
  const invoice: InvoiceDocument = { id: "DEMO-INV-1", issuer: seller, debtor: buyer, amount: C(60), memo: "demo web design" };
  try {
    const notice: InvoiceNotice = { circle: o.circleContract, invoice_hash: invoiceHash(invoice), actor: seller, action: "requested", at: o.nowS, reason: null };
    record("P8 invoice", invoice.id, await client.post("/invoices", { document: invoice, installments: 3, notice, signature: signNoticeJson(serializeInvoiceNotice(notice), o.circleContract, o.keys.seller.secretKey) }));
  } catch (error) {
    results.push({ pipeline: "P8 invoice", item: invoice.id, outcome: "failed", detail: (error as Error).message.slice(0, 160) });
  }
  return results;
}
