# License handover (BE-056, ADR-46)

Routes of spec 5g. Format, encryption, release and proof of cheating: `@x207/core` (`license.ts`, SD-070). x207 stores no file: the seller keeps the **ciphertext** at any source (`https` or `ipfs`) and the backend never sees the key or the plain file.

## Listing
`Listing.detail` of a license is JSON `{kind: "license", license_doc, content_hash, license_id, exclusive, …}` with an `offer.asset_type` of the content kinds (`data:dataset`, `model:weights`, `ads:promo-slot`, `design:template`, `creative:licensed-asset`, `plugin:preset`, `course:own-class`, `content:own-work`, `data:own-anonymized`; the NFT `license:software-nft` is another thing). The listing check (also `POST listings/check`) refuses:
- a `license_id` that is not on the list (`400 license_id_rejected`; `GET marketplace/license-ids` lists the ids and whether each lets the buyer redistribute; standard stock licenses are not on it, ADR-46 point 6);
- a `preview` (text in `detail`, ≤ 16 KB) with a wrong `preview_hash`, or with personal data (`400 preview_contains_pii`, `details.kinds`: `email`, `nik`, `phone`, `card`, `us_ssn`, `iban`; the matches are never echoed). The seller can appeal only by posting a clean preview; there is no appeal route.

## Purchase
1. `POST listings/{hash}/purchases` `{voucher, signature}` of the buyer: payee is the seller, `resource` is `x207:license:<license_doc>`, epoch is the open epoch, `seq` rises and the cumulative amount grows at least by the price. The voucher is **held**: it is in no answer until the purchase is `confirmed` or `refuted`. Answer `{purchase_id, …}`.
2. Seller `cipher_posted`: notice keys `circle, purchase_id, actor, action, at, source, cipher_hash`. The source is checked for availability with `HEAD` behind the SSRF guard (`403 source_forbidden`; a source that does not answer is `409 purchase_bad_state`).
3. Seller `key_released`: the notice **is the `LicenseRelease`** of the SDK (`circle, license_hash, buyer, content_hash, cipher_hash, sealed_key, at`), signature from `signRelease`. It must match the purchase (buyer, `cipher_hash`, `content_hash`). `disputeUntil` = `at` + the window (72 hours).
4. Buyer `confirmed`, `disputed` or `cancelled`: notice keys `circle, purchase_id, actor, action, at, reason, proof` (the format of FE-028). **Silence for the whole window confirms.**
5. A dispute `content_mismatch` carries `proof: {release, signature, box_key}`. **The backend checks it itself:** the release must be the one the seller gave; it downloads the ciphertext from the source the seller named (guard, ≤ 256 MiB, an IPFS answer must match its CID), requires `cipher_hash`, and runs `checkCheatProof`. Valid → `disputed` (not paid, voucher stays held). A proof for a correct file → `refuted` (paid: the voucher is released to the seller). `contains_pii` and `other` need no proof, end in `disputed`, and are not adjudicated. Disputes are accepted only inside the window.
6. `cancelled`: the seller until the buyer confirms; the buyer only before the key is released and after the window since the purchase.

A voucher released after `confirmed` or `refuted` is for the seller (or its facilitator) to register; the backend registers nothing.

## Exclusive license
Recorded per `content_hash` from the live purchases (`paid_held`, `cipher_posted`, `key_released`, `confirmed`). An exclusive purchase is refused (`409 exclusive_taken`) when any license of that content is live; any purchase is refused while an exclusive one is live. `GET marketplace/exclusive-licenses?content_hash=` lists the holders. A sale that is cancelled or lost in a dispute frees it. An exclusive purchase carries `needsBond: true` (the bond of CT-094 is not checked here).

## Takedown
`POST listings/{hash}/takedown` `{claim, evidence_hash, signature}`; the signature is over `{"circle","listing_hash","claim","evidence_hash"}` (JSON in that order) with the voucher key of an active member, who becomes the claimant (the body names none). The listing becomes `cancelled`; purchases not yet confirmed (`paid_held`, `cipher_posted`, `key_released`, `disputed`) are cancelled and their vouchers never leave; confirmed ones stay (ADR-20). The backend does not judge the claim.

## Limits
- The seller who releases a sealed key that cannot be opened, or posts a wrong file whose release was never made, cannot be proven cheating: the buyer disputes `other`, and the voucher stays held.
- The seller who changes one byte of an exclusive file is not detected (ADR-46 point 2).
- `contains_pii` in a purchased file cannot be checked (the backend has no key).
- The reputation of BE-053 does not read purchases yet.
