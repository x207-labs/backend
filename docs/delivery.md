# Delivery of an off-chain asset (BE-047)

An asset of class A moves atomically through the escrow of the contract. Most assets in part F of the barter catalogue (a code, a seat, a domain, a file) cannot: the seller hands it over outside the chain and nobody can prove from the chain that it arrived. The marketplace therefore holds the payment back until the receiver says so.

## Flow
1. A match on a listing whose offered asset has class `B` or `C` (setting `confirmClasses`; class `A` is atomic, class `D` is paid per use) starts a `deliveries` row in `awaiting`. `accept` says so in `result.delivery` (`{required, payable, state}`); matches that need no confirmation keep the old shape.
2. The seller signs a notice `delivered`, with an optional `proof_hash` (sha256 of the proof kept off-chain). State `delivered`; the receiver has `disputeWindowSeconds` (default 72 hours) from the time of the notice.
3. The receiver signs `confirmed` (state `confirmed`, `payable: true`) or `disputed` with a reason `not_received`, `not_as_described` or `other` (only inside the window; state `disputed`, which stays: nobody can pay through this match).
4. `cancelled`: the seller until the receiver confirms; the receiver only when the state is still `awaiting` and `deliver_by` of the accepted offer has passed.
5. The voucher or the bundle of the match is registered only after `confirmed`. For a bundle the backend enforces it: the proposal stays `proposed`, not `ready`, even when everybody signed, until the confirmation arrives. For a plain payment (`kind: payment`) the backend only reports `payable`; the party that registers the voucher (SDK, facilitator) must check `GET …/delivery` first.

## Routes
- `GET /x207/circles/{circle}/listings/{hash}/delivery` → state, parties, times, `payable` and every notice with its signature. `404 delivery_not_found` when the match needs no confirmation.
- `POST /x207/circles/{circle}/listings/{hash}/delivery` with `{notice, signature}` → the new state (201). Errors: `400 invalid_request` (format, `circle`, hashes, `at` more than 600 s from the server clock), `401 invalid_signature`, `403 not_a_party` (wrong actor for the action, or not a party), `409 delivery_state` (action not allowed in this state, dispute window over), `409 already_exists` (notice repeated).

## Notice format
Canonical JSON with the keys in this order: `circle, listing_hash, offer_hash, actor, action, at, proof_hash, reason`. `circle` is the contract account, the hashes are 64 lowercase hex, `at` is unix seconds, `proof_hash` is set only for `delivered`, `reason` only for `disputed` (both `null` otherwise). The signature is ed25519 over the NEP-413 style hash of the JSON, as for offers and listings (`nep413SigningHash(json, sha256(json), circle)`), made with the voucher key of the actor. Code: `src/marketplace/delivery-core.ts` (`signDeliveryNotice`, `verifyDeliveryNoticeSignature`); it should move into `@x207/core` with test vectors.

## What this does not do
- It does not decide who is right in a dispute. `disputed` is final here; a ruling needs the arbiter of `docs/reputation-and-disputes.md` (option 4) and a contract change (see `contracts/docs/payment-hold.md`).
- A listing that was matched is not reopened after a cancellation.
- Only the offered side of a listing is tracked (seller to counterparty). In `barter` mode the counterparty's own handover is not.
- The receiver can stay silent: the match then stays `delivered` and nothing is paid. The seller's only remedy is the reputation of the receiver (option 2 of the note).
- The notice proves that a member said something, nothing more.
