# Proofs of a `delegate` order: claims checked through RPC (BE-055 fix, design)

Status: built (SD-072 is in the SDK as `7b1b996`). No change to the indexer: the votes are calls to the DAO, not events of the circle, so the seller **claims** each transaction and the backend checks it once through the configured RPC (not an address given by a user, so no SSRF).

## Order
`kind: delegate` carries `mandate_hash` (after `proof`, before `nonce`). `POST orders` for it also carries the document `mandate` (a field of the body next to `order` and `signatures`) `{circle, dao, kinds, rules_hash}` (keys in that order); the backend refuses the order unless `mandateHash(mandate) === order.mandate_hash` (function of SD-072) and `mandate.circle` is the contract. The mandate is kept with the order (`orders.mandate_json`, D9-marketplace migration). `mandate.kinds` are the variants of `ProposalKind` of Sputnik v2 in snake_case (`transfer`, `function_call`, `add_member_to_role`, `vote`, …).

## Route
`POST /x207/circles/{circle}/orders/{hash}/claims` body `{tx_hash, notice, signature}`. The notice is canonical JSON with the keys `circle, order_hash, actor, action, at, tx_hash`, `action` is `claim`, `actor` is the seller, signed with its voucher key as the other notices (`notice.ts`). The order must be `open` and of kind `delegate`.

The backend asks the RPC for `tx` (`[tx_hash, seller]`, `wait_until: FINAL`) once and accepts when:
1. the transaction exists (`tx_not_found`) and its status and the status of every receipt is a success (`tx_failed`);
2. `signer_id` is the seller (`wrong_signer`) and `receiver_id` is `mandate.dao` (`wrong_receiver`);
3. it has exactly one action, a `FunctionCall` of `act_proposal` whose args are `{id, action, …}` with `action` `VoteApprove` or `VoteReject` (`not_a_vote`; `Finalize`, `VoteRemove`, `AddProposal` and the rest are not votes);
4. the kind of the proposal `id` is in `mandate.kinds` (`kind_not_in_mandate`): the view `get_proposal({id})` of the DAO gives `kind` as a name (`"Vote"`) or an object with one key (`{"Transfer": …}`); the name is made snake_case (`Transfer` to `transfer`, `FunctionCall` to `function_call`). The kind of a proposal does not change, so it is cached per `(dao, id)` (`order_proposal_kinds`);
5. the block of the transaction is not older than the order (`before_order`): a seller cannot claim votes cast before the agreement (the RPC `block` gives the time);
6. this `proposal_id` is not claimed yet for this order, and this `tx_hash` is not claimed for any order of the circle (`already_claimed`): a second vote on the same proposal is refused, not counted.

Errors: `400 claim_invalid` with `details.reason` one of `tx_not_found`, `tx_failed`, `wrong_signer`, `wrong_receiver`, `not_a_vote`, `kind_not_in_mandate`, `already_claimed`, `before_order`; `503 claim_rpc_unavailable` when no RPC is configured; the usual `invalid_signature`, `order_not_party` (only the seller claims), `order_bad_state`.

## Proofs
`GET orders/{hash}/onchain-proofs` of a `delegate` order lists the claims in order of acceptance: `{txHash, method: "act_proposal", signer, receiver, proposalId, action, proposalKind}`; one item per `proposal_id`.

## Storage (D9-marketplace)
`orders.mandate_json`; `order_claims(circle_id, order_hash, proposal_id, tx_hash, signer, receiver, action, proposal_kind, created_at_ms)` with `PRIMARY KEY (circle_id, order_hash, proposal_id)` and `UNIQUE (circle_id, tx_hash)`; `order_proposal_kinds(dao, proposal_id, kind)`.

## Tests (unit, with a mock RPC that answers `tx` and `get_proposal`)
A vote that is valid; `Finalize` refused; a second vote on the same proposal refused (`already_claimed`) and the same transaction claimed for another order refused; a kind outside the mandate refused; a signer that is not the seller refused; another receiver refused; a failed transaction refused; a transaction the RPC does not know refused; a mandate whose hash is not `mandate_hash` refuses the order; the kind is read once per proposal (cache).

## Limit
The check is made when the claim arrives: a transaction final at that moment stays final, but the backend trusts the RPC it is configured with. The seller can only claim what it signed.
