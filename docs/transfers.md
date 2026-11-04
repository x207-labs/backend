# Transfer through the official feature of a platform (BE-074, P4, ADR-49)

A domain, a game item or a ticket changes hands through the **official feature of its platform** (a registrar transfer, a Steam trade offer, a ticket transfer). x207 holds the voucher of the buyer until the platform shows that the transfer happened. The contract does not change. The format of the listing is SD-077 (`@x207/core`, `docs/transfer.md` of the SDK): the document, its hash, the resource `x207:transfer:<hash>`, the TXT texts (`sellTxt`, `ownTxt`, `parseTxt`) and the 14 `TransferError` codes are used as they are; the backend adds its own errors (`transfer_seller_unproven`, `transfer_proof_pending`, `transfer_window_passed`, `transfer_platform_unavailable`, `transfer_proof_not_configured`, `transfer_not_found`, `transfer_not_party`, `transfer_bad_state`, `asset_roadmap_only`).

## The listing
`POST /listings` with `offer.asset_type` `transfer:domain`, `transfer:game-item` or `transfer:ticket` (class B, quantity 1) and `detail` JSON:
`{"kind":"transfer","transfer_doc":"<hash>","platform":"domain|game_item|ticket","transfer_ref":"…","proof_method":"dns_txt|trade_api|buyer_confirm","estimate_seconds":N,"nonce":"…"}`.
`transfer_doc` is the hash of `{circle, seller, platform, transfer_ref, proof_method, estimate_seconds, value, nonce}` (`seller` is the listing account, `value` is `offer.value`). The mapping is fixed: domain = `dns_txt`, game item = `trade_api`, ticket = `buyer_confirm`. `transfer_ref` is the domain name, `<appid>:<assetid>` of a Steam item, or the ticket reference.

| Rule | Error |
| --- | --- |
| a website or an online store (#67): `transfer:website`, `transfer:online-store` | `asset_roadmap_only` (400) |
| detail is not a transfer, or the platform is not the one of the asset type | `transfer_bad_platform` |
| the method is not the one of the platform | `transfer_method_mismatch` |
| `transfer_ref` is not a domain name / `<appid>:<assetid>` / 1 to 256 characters | `transfer_bad_ref` |
| `estimate_seconds` is outside 1 to the window of the platform | `transfer_bad_estimate` |
| `nonce` empty or longer than 64 characters | `transfer_bad_nonce` |
| quantity is not 1, or the value is not a whole number above 0 | `transfer_bad_value` |
| a ticket above 100 credit | `transfer_ticket_over_limit` |
| value at or above `bond_threshold` (100 credit): this is a bundle of two legs with an arbiter (CT-094, SD-067), not this ledger | `transfer_arbiter_required` |
| `transfer_doc` is not the hash of the document | `transfer_bad_hash` |
| **domain**: the TXT `x207-sell=<listing_hash>` is not on `transfer_ref` yet | `transfer_seller_unproven` (409) |
| **domain**: the DNS did not answer | `transfer_platform_unavailable` (503) |

The seller of a domain sets the TXT before the listing, so the `listing_hash` is the one of the body that is posted. The dry run `POST /listings/check` makes the same checks, DNS included.

## The purchase
`POST /listings/{hash}/transfers` body `{voucher, signature, buyer_ref?}`. The voucher is for the seller, `resource` is `x207:transfer:<transfer_doc>`, the epoch is open, and `cumulativeAmount` adds the price to the highest cumulative that the pair already has, **counting the vouchers that purchases and transfers still hold** (B7-C3). A game item needs `buyer_ref`, the Steam account id of the buyer. One buyer per thing (`exclusive_taken`), and the open limit of purchases applies. The answer is the transfer with `status: "paid_held"` and `windowUntil`; for a domain also `instructions: {setTxtAfterTransfer: "x207-own=<id>", on: "<domain>"}`.

The window per platform: **domain 7 days, ticket 1 day, game item 1 hour**. When it passes without the proof the transfer is `cancelled` (`cancelReason: transfer_window_passed`), the voucher never moves, and the cancelled voucher no longer counts for the pair.

## The proof
| Platform | Method | Met when |
| --- | --- | --- |
| domain | `dns_txt` | TXT `x207-own=<transfer id>` on the domain (DNS over HTTPS), and RDAP shows a live domain of that name that is not `pending transfer`, `pending delete`, `redemption period`, `server hold`, `client hold` or `inactive` |
| game item | `trade_api` | the Steam trade offer is `accepted` (state 3), goes to `buyer_ref`, gives `<appid>:<assetid>`, and its hold (`time_escrow_end`) is over |
| ticket | `buyer_confirm` | the buyer signs the notice `confirmed` |

`POST /transfers/{id}/proof` (domain: body `{}`; game item: `{"tradeoffer_id": "<digits>"}` the first time, fixed after) asks the platform. It is objective and needs no signature, and it is limited to one check each 30 seconds per transfer (`rate_limited`, `retryAfterSeconds`), whoever asks, and the rate limit of BE-066 per address applies to the route as well; `transfer_proof_pending` carries `retryAfterSeconds` (the larger of that gap and what the platform says, e.g. the hold of a trade). Answers: `200` with `status: "confirmed"` and the voucher; `409 transfer_proof_pending` with what is missing (`want`, `reason`, `retryAfterSeconds`), the voucher still held; `503 transfer_platform_unavailable` when DNS, RDAP or Steam did not answer (nothing is decided); `501 transfer_proof_not_configured` when the backend has no Steam key; `409 transfer_window_passed` when it is over. `POST /transfers/{id}` takes the signed notices `{circle, transfer_id, actor, action, at}` with `action` `confirmed` (the buyer, a ticket only) or `cancelled` (the buyer or the seller while the voucher is held), `403 transfer_not_party` for others.

When the proof is met the listing is closed (`matched`) and the voucher is shown on the transfer (`voucher`, `voucherSignature` for the seller to register). `GET /transfers/{id}` shows the state; the window is applied on every read.

## Where the outside is asked
Every request goes through the SSRF guard of BE-054/056 (`guardedGet`): https only, public addresses only, no redirect, a small body. DNS over HTTPS uses the JSON answer of `X207_DOH_URL` (default `https://dns.google/resolve`), RDAP uses `X207_RDAP_BASE_URL` (default the Verisign registry of `.com` and `.net`; another TLD needs its own base), Steam uses `X207_STEAM_API_KEY` (a secret: it is in the URL of the request to Steam only, never in an answer, a log or the proof that is stored).

## Reputation (BE-078)
The reputation of BE-053 counts the sales of a seller whatever they sold: a confirmed (or `refuted`, the complaint of the buyer proved false and the seller paid) file license, a confirmed or refuted code and a confirmed transfer are **completed**; a purchase that ended `disputed` is a **dispute**; a transfer cancelled with `transfer_window_passed` is **abandoned** (a failure of the seller). The rule is the one of the other disputes: one count per counterparty, and a dispute or an abandoned transfer counts only from a buyer that has paid somebody itself (a fresh account cannot damage anybody). The list `GET /reputation` includes sellers of files, codes and transfers. A domain window that passes because the *buyer* never set the TXT is counted against the seller as well, because the backend cannot tell the two apart.

## Limits written down
- A registrar can take a transfer back for about 60 days; the bond window is 14 days (ADR-49 point 2). The proof says the buyer controlled the domain when it was checked, not that the registrar will not reverse it.
- Steam: the trade offer proves the item moved to the buyer's account, not that the item is the genuine one; `assetid` changes when an item changes hands, so an old accepted trade cannot carry the asset id of the listing. A trade is asked by id, so the seller must tell the id.
- A ticket is the word of the buyer: a buyer who never confirms cancels the sale after one day (the seller is not paid), and a buyer who confirms and then says the ticket was bad has the reputation route, not a dispute here.
- RDAP of a TLD other than `.com` and `.net` needs `X207_RDAP_BASE_URL`; the redirecting `rdap.org` is not used because a redirect is refused.
