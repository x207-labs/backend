// The proofs of a transfer (BE-074, ADR-49). One adapter per method: `dns_txt` (a DNS TXT record and RDAP, for a domain), `trade_api` (the trade offer API of Steam, for a game item) and
// `buyer_confirm` (the buyer says so, for a ticket). An adapter answers `met`, `pending` (not yet: the voucher stays held) or `unavailable` (the platform did not answer: nothing is
// decided). Every request goes through the SSRF guard (`guardedGet`): https only, public addresses only, no redirect, a small body. The HTTP is injectable for the tests (`resolver`, `transport`).
import { guardedGet, type Resolver, type Transport } from "./ssrf.js";
import { txtOwn, txtSell } from "./transfer-types.js";

export type ProofVerdict = { status: "met"; detail: Record<string, unknown> } | { status: "pending"; detail: Record<string, unknown> } | { status: "unavailable"; detail: Record<string, unknown> };

export interface HttpOptions {
  resolver?: Resolver;
  transport?: Transport;
}

/** Fetch JSON through the guard; `null` when the platform did not answer or did not answer 200 with JSON. */
async function getJson(url: string, http: HttpOptions): Promise<{ status: number; json: unknown } | null> {
  const res = await guardedGet(url, { ...(http.resolver ? { resolver: http.resolver } : {}), ...(http.transport ? { transport: http.transport } : {}), code: "target_forbidden", maxBytes: 256 * 1024, timeoutMs: 8_000 });
  if (!res.reachable) return null;
  try {
    return { status: res.status, json: JSON.parse(res.body) };
  } catch {
    return res.status === 404 ? { status: 404, json: null } : null;
  }
}

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const isDomainName = (value: string): boolean => DOMAIN.test(value);

export interface DnsTxtOptions extends HttpOptions {
  /** DNS over HTTPS with the JSON answer of Google (`?name=&type=TXT`). Env `X207_DOH_URL`. */
  dohUrl?: string;
  /** RDAP base ending with a slash (`<base><domain>`), the registry of the TLD (no redirect is followed). Env `X207_RDAP_BASE_URL`. */
  rdapBaseUrl?: string;
}
export const DEFAULT_DOH_URL = "https://dns.google/resolve";
export const DEFAULT_RDAP_BASE_URL = "https://rdap.verisign.com/com/v1/domain/";
/** RDAP statuses that say the domain is not in the hands of an owner who can use it. */
const BAD_RDAP_STATUS = ["pending transfer", "pending delete", "redemption period", "server hold", "client hold", "inactive"];

export class DnsTxtProof {
  readonly #o: DnsTxtOptions;
  constructor(options: DnsTxtOptions = {}) {
    this.#o = options;
  }

  /** The TXT strings of a name, each as the text between the quotes; `null` when the resolver did not answer. */
  async txt(domain: string): Promise<string[] | null> {
    if (!isDomainName(domain)) return [];
    const answer = await getJson(`${this.#o.dohUrl ?? DEFAULT_DOH_URL}?name=${encodeURIComponent(domain)}&type=TXT`, this.#o);
    if (answer === null || answer.status !== 200) return null;
    const body = answer.json as { Status?: number; Answer?: Array<{ type?: number; data?: unknown }> } | null;
    if (body === null || typeof body !== "object") return null;
    if (body.Status === 3) return []; // NXDOMAIN: no such name
    if (body.Status !== 0) return null;
    return (body.Answer ?? []).filter((a) => a.type === 16 && typeof a.data === "string").map((a) => String(a.data).replace(/^"|"$/g, "").replace(/"\s+"/g, ""));
  }

  /** The seller proves control of the domain BEFORE the listing: `x207-sell=<listing_hash>`. */
  async sellerControls(domain: string, listingHash: string): Promise<ProofVerdict> {
    const records = await this.txt(domain);
    if (records === null) return { status: "unavailable", detail: { check: "dns" } };
    return records.includes(txtSell(listingHash)) ? { status: "met", detail: { txt: txtSell(listingHash) } } : { status: "pending", detail: { want: txtSell(listingHash), found: records.slice(0, 5) } };
  }

  /** After the transfer the buyer sets `x207-own=<purchase_id>`; the registry (RDAP) must show a live domain that is not in the middle of a transfer or a deletion. */
  async buyerControls(domain: string, purchaseId: number): Promise<ProofVerdict> {
    const records = await this.txt(domain);
    if (records === null) return { status: "unavailable", detail: { check: "dns" } };
    if (!records.includes(txtOwn(purchaseId))) return { status: "pending", detail: { want: txtOwn(purchaseId), found: records.slice(0, 5) } };
    const rdap = await getJson(`${this.#o.rdapBaseUrl ?? DEFAULT_RDAP_BASE_URL}${encodeURIComponent(domain)}`, this.#o);
    if (rdap === null || (rdap.status !== 200 && rdap.status !== 404)) return { status: "unavailable", detail: { check: "rdap" } };
    if (rdap.status === 404) return { status: "pending", detail: { rdap: "domain not found in the registry" } };
    const r = rdap.json as { ldhName?: unknown; status?: unknown } | null;
    const statuses = Array.isArray(r?.status) ? (r.status as unknown[]).map((s) => String(s).toLowerCase()) : [];
    const bad = statuses.filter((s) => BAD_RDAP_STATUS.includes(s));
    if (typeof r?.ldhName !== "string" || r.ldhName.toLowerCase() !== domain.toLowerCase()) return { status: "pending", detail: { rdap: "the registry answered for another name" } };
    if (bad.length > 0) return { status: "pending", detail: { rdap: "the domain is not settled in the registry", statuses: bad } };
    return { status: "met", detail: { txt: txtOwn(purchaseId), rdapStatus: statuses } };
  }
}

export interface TradeApiOptions extends HttpOptions {
  /** Web API key of Steam; a secret: never logged, never in an answer. Env `X207_STEAM_API_KEY`. */
  apiKey: string;
  baseUrl?: string;
}
export const DEFAULT_STEAM_URL = "https://api.steampowered.com";
/** Steam `ETradeOfferState`. */
const STEAM_ACCEPTED = 3;

export class TradeApiProof {
  readonly #o: TradeApiOptions;
  constructor(options: TradeApiOptions) {
    this.#o = options;
  }

  /**
   * The trade offer must be `accepted` (state 3), carry the item that the listing names (`appid:assetid` in what the seller gives), go to the buyer (`accountid_other`) and be past its hold
   * (`time_escrow_end` of Steam: 0 or absent when there is none). Paid only then.
   */
  async check(args: { tradeOfferId: string; itemRef: string; buyerAccount: string; nowS: number }): Promise<ProofVerdict> {
    if (!/^\d{1,20}$/.test(args.tradeOfferId)) return { status: "pending", detail: { reason: "tradeoffer_id is a number" } };
    const url = `${(this.#o.baseUrl ?? DEFAULT_STEAM_URL).replace(/\/+$/, "")}/IEconService/GetTradeOffer/v1/?key=${encodeURIComponent(this.#o.apiKey)}&tradeofferid=${args.tradeOfferId}`;
    let answer: Awaited<ReturnType<typeof getJson>>;
    try {
      answer = await getJson(url, this.#o);
    } catch (error) {
      // the guard refused the target: the message names the host and never the key
      return { status: "unavailable", detail: { check: "trade_api", reason: (error as Error).name } };
    }
    if (answer === null || answer.status !== 200) return { status: "unavailable", detail: { check: "trade_api", httpStatus: answer?.status ?? null } };
    const offer = (answer.json as { response?: { offer?: { trade_offer_state?: number; accountid_other?: number | string; time_escrow_end?: number; items_to_give?: Array<{ appid?: number | string; assetid?: number | string }> } } } | null)?.response?.offer;
    if (offer === undefined) return { status: "pending", detail: { reason: "Steam knows no such trade offer" } };
    if (String(offer.accountid_other) !== args.buyerAccount) return { status: "pending", detail: { reason: "the trade offer is not to the buyer" } };
    const gives = (offer.items_to_give ?? []).map((i) => `${i.appid}:${i.assetid}`);
    if (!gives.includes(args.itemRef)) return { status: "pending", detail: { reason: "the trade offer does not carry the item of the listing" } };
    if (offer.trade_offer_state !== STEAM_ACCEPTED) return { status: "pending", detail: { reason: "the trade offer is not accepted yet", tradeOfferState: offer.trade_offer_state ?? null } };
    const holdEnds = offer.time_escrow_end ?? 0;
    if (holdEnds > args.nowS) return { status: "pending", detail: { reason: "the hold of the trade is not over", holdEndsAt: holdEnds, retryAfterSeconds: holdEnds - args.nowS } };
    return { status: "met", detail: { tradeOfferState: STEAM_ACCEPTED, holdEndsAt: holdEnds } };
  }
}
