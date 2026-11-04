# Security review, batch 5 (BE-062): SD-074 facilitator and frozen accounts, SD-072 delegate order

Scope, read only: `sdk/apps/facilitator` (`chain-cache.ts`, `chain.ts`, `rpc.ts`, `app.ts`) and `sdk/packages/scheme/facilitator/verify.ts` for SD-074 (`fc4fa08`, `29f4fd6`, `fb55d5a`); `sdk/packages/core/src/order.ts` for SD-072 (`7b1b996`). Nothing was changed in the SDK. The contract side (`freeze.rs`: `is_frozen`, `assert_not_frozen_for_voucher`) was read for the meaning of "frozen". The backend side of SD-072 (claims, BE-055 fix, `9017a33`) is also listed, because it is the other half of the same flow.

Levels as in batch 2: High = money or a proof can be forged by the other party with no cooperation; Medium = a documented guarantee does not hold under a caller mistake that is easy to make, or a party can gain with a plausible setup; Low = hardening; Info = a limit to write down.

## Summary
| # | Level | Where | Finding |
| --- | --- | --- | --- |
| B5-F1 | Medium | `order.ts` `payForProofs` (`alreadyPaid`), SD-072 | The dedupe key of a delegate order is `proposal:<id>`, but `alreadyPaid` is documented as "transaction hashes already paid" and the result has `paid` (hashes) and `keys` (the real keys). A caller that feeds `paid` back pays the same proposal again |
| B5-F2 | Medium | `chain.ts` `NearChain.isFrozen`, `app.ts` `onError`, SD-074 | A facilitator of this version against a contract older than 0.0.12 answers every `/verify` and `/settle` with `500 internal_error`: the view `is_frozen` does not exist, and the "no view, no check" rule only covers a chain object without the method, not a contract without the view |
| B5-F3 | Low | `order.ts` `verifyTx`, SD-072 (and F12 of batch 2) | `verifyTx` is synchronous, so a buyer cannot ask the DAO or the RPC from it; in practice the proofs of the backend are trusted as they are |
| B5-F4 | Low | backend `order-claims.ts` (BE-055 fix) | `mandate.dao` is any account the two parties sign: nothing says it is a DAO. A seller that proposes its own contract as the "DAO" can claim "votes" that no DAO saw |
| B5-F5 | Low | `order.ts` `payForProofs`, `docs/order.md` | The order of the refusals in the document (`wrong_signer`, `wrong_receiver`, `wrong_method`, …) is not the order in the code (`wrong_signer`, `wrong_method`, then the delegate reasons) |
| B5-F6 | Info | `verify.ts`, `chain-cache.ts`, SD-074 | The window of 10 s of the `is_frozen` cache, and the stricter rule in the epoch of the freeze |
| B5-F7 | Info | `order.ts`, `mandate.rules_hash`, SD-072 | The mandate fixes the kinds, not how the delegate votes; `rules_hash` is evidence only |
| B5-F8 | Info | backend `order-claims.ts` | `before_order` compares with the time the order was first posted, not the time the second party signed |

Checked and found sound: a failed `is_frozen` read is not cached, and `Promise.all` rejects the whole `verify`, so an RPC error is fail-closed (no `isValid: true` from a missing answer; test `TC-SD-074-01` has the case `fail: true`); a frozen payee is looked at with `voucher.payee`, not with the requirement, so the two sides are both covered; the cache key is the account, so a stale `true` after `unfreeze_member` costs a refusal of at most 10 s and never a payment; the check comes after `payee_not_active`, so the number of `is_frozen` reads per 10 s is bounded by the number of members, also for forged vouchers; `mandate_hash` is written only for `delegate` and sits between `proof` and `nonce`, so the hash of every other order is unchanged (`TC-SD-072-02`); `kinds` are sorted, so two orders of the list give one hash; `mandate.circle` must be the circle of the order; a mandate whose hash is not `order.mandate_hash` is refused; `signOrderClaim` uses the same NEP-413 scheme as the other notices; `receiver`, `action` and the kind of the proposal are all checked before the key is looked at, and the budget stops a long list.

## B5-F1 (Medium): `alreadyPaid` of a delegate order is not the list of paid transactions
`payForProofs` computes `key = proposal:<id>` for a delegate and looks it up in `new Set(args.alreadyPaid)`. The result returns `paid` (transaction hashes, the same name and meaning as for a keeper order) and `keys`. The comment on `alreadyPaid` says "transaction hashes that are already paid". A caller who keeps `result.paid` and passes it back as `alreadyPaid` (the natural reading, and what works for `keeper` and `solver`) is not protected: the key `proposal:7` is not in the set, so a second transaction of the same proposal is paid. `OrderLedger.payProofs` stores `result.keys` and is safe; the bare function is not.
Test (run, then deleted): delegate order, proof `T1` for proposal 7 paid, then `payForProofs` with `alreadyPaid: first.paid` and proof `T2` for proposal 7: `paid: ["T2"]` (pays again). With `alreadyPaid: first.keys` the result is `already_paid`.
Reach: the seller can send two transactions for one proposal (it is allowed on the DAO until the vote is final) and the backend lists only the first claim, so against the backend list the buyer is safe; but the backend list is the one place the double can be stopped, and a buyer that merges lists, or a second backend, can see both.
Fix: in the SDK, accept both forms (`alreadyPaid` may hold hashes and keys; for a delegate also add `proposal:<id>` of every paid hash it can map) or rename and type the argument (`alreadyPaidKeys`); say it in `docs/order.md`. Owner: sdk and frontend team.

## B5-F2 (Medium): a contract older than 0.0.12 makes every verify an internal error
`NearChain.isFrozen` is always defined and calls the view `is_frozen`. On a contract without that view the node answers a `call_function` query with an error and no result bytes (the shape was not captured on a chain; this is read from the code). Then either `NearRpc` throws a `RpcError` or `Buffer.from(undefined)` throws a `TypeError`; neither is a `ChainUnavailableError`, so `app.onError` answers `500 internal_error`, not `503 Retry-After`. `CachedVerifyChain.isFrozen` keeps `inner.isFrozen` optional, but `NearChain` never lacks it, so the line "an inner chain of an older contract has no `is_frozen`" is true only in the unit tests (`TC-SD-074-01`, `frozen` undefined). The spec row 13a says "skipped when the facilitator has no such view".
Effect: fail-closed, so no money is at risk, but a facilitator rolled out before the contract is upgraded (or a circle on 0.0.11) accepts no payment at all until it is rolled back.
Not run on a chain (read from the code and from `rpc.ts`).
Fix: in `NearChain.isFrozen`, turn a missing-method answer into `false` (and log once), or read the version of the contract at start and set `isFrozen` only for 0.0.12 or higher. Owner: sdk and frontend team.

## B5-F3 (Low): `verifyTx` cannot ask the chain
`verifyTx?: (proof) => boolean` is synchronous. The doc says it is the hook to ask the chain again. To use it a buyer has to read every transaction first and keep the answers in a map, which nobody will do by default. A backend that lists a claim that never happened (a bug, or a read API that is not the one of the circle) is believed up to the budget. Not new in SD-072 (it was F12 of batch 2); the delegate order makes it matter more, because the vote is not an event of the circle and the backend is the only witness.
Fix: allow `verifyTx` to return a promise (`payForProofs` becomes async), or document a helper that checks `tx_hash` through `EXPERIMENTAL_tx_status`. Owner: sdk and frontend team.

## B5-F4 (Low): `mandate.dao` is not checked to be a DAO
`POST orders` and `POST claims` accept any account as `mandate.dao`; the claim is valid when the transaction succeeded, went to that account, is one `act_proposal` with `VoteApprove` or `VoteReject`, and `get_proposal` of that account says the kind is in the list. Both views are answered by whoever runs the account. A seller can name a contract of its own as the DAO (the buyer signs the order, so the buyer agreed to that address), vote on proposals that exist only there, and be paid. The buyer sees the address in the mandate, but an agent that signs orders from a template does not look.
Fix, backend: when `daoRegistry` is not empty, refuse an order whose `mandate.dao` is not in it (`order_bad_mandate`, reason `dao_not_listed`); the registry is the list the governance of the circle already keeps (BE-061). Where there is no registry, say it in `docs/order.md`. Owner: backend team (not changed in this commit: it changes who can make a delegate order, so it needs a decision).

## B5-F5 (Low): documented order of refusals differs from the code
`docs/order.md` lists `wrong_signer`, `wrong_receiver`, `wrong_method`, `not_a_vote`, … The code returns `wrong_method` before `wrong_receiver`. A proof that breaks two rules gets a different reason from the one a reader expects; nobody is paid in either case. Fix: change the text or the order. Owner: sdk and frontend team.

## B5-F6 (Info): the 10 s window and the epoch of the freeze
A freeze applied in the last 10 s is not seen by `/verify` and `/settle` (they share the cache), so a voucher can be accepted for up to 10 s. The contract accepts a voucher of a frozen account up to the end of the epoch of the freeze (`assert_not_frozen_for_voucher`: refused only for a later epoch), so the registration of that voucher succeeds and nobody loses; for a voucher of a later epoch the registration fails and the row is dropped (the loss is the one of the documented window of `member`). The facilitator is stricter than the contract in the epoch of the freeze on purpose (spec row 13a): a seller that delivered before the freeze cannot get a new voucher accepted after it, even though the contract would register it.
Pending freeze: `is_frozen` is `true` only after `apply_freeze`, so nothing is refused during the day between `propose_freeze` and `apply_freeze`; that is the design of ADR-43, not a gap of the facilitator.

## B5-F7 (Info): the mandate does not bind the vote
The delegate is paid for `VoteApprove` and for `VoteReject` alike, on any proposal of a listed kind. `rules_hash` proves what was promised, not what was done. Written in `docs/order.md` already; kept here so that a buyer does not read the mandate as a guarantee of the direction of the vote.

## B5-F8 (Info): `before_order`
The backend compares the block time of the vote with `orders.created_at_ms`, the moment the first signature was posted. Votes between the first and the second signature count. The cost to the buyer is at most the votes of a few minutes that it could have asked for; if it matters, compare with the time of the second signature (`status` becomes `open`).

## Summary of the fixes
None done in this commit (SDK is not mine; B5-F4 needs a decision). The tracker has B5-F1 to B5-F8.
