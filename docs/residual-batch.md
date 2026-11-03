# BE-034: N-party residual through one `execute_intents`

Code: `src/settlement/residual/batch.ts`, tests `test/settlement/residual-batch.test.ts` (12 pass, no network). Study behind it:
`contracts/docs/ct058-atomic-residual-intents.md`.

## What is built (the worker side)
- `planResidualBatches(positions, { circleContract, epoch })`: one Intents `transfer` per net debtor with `receiver_id` = the circle, the USDT
  token as `nep141:<account>`, and `msg` = `{"action":"settle","epoch":N}`; zero amounts left out, calls of at most 5 debtors.
- `checkSignedPayload`: the signed message of each debtor is JSON of exactly its planned transfer (`signer_id`, `verifying_contract`, intent).
- `runResidualBatch`: check payloads, `simulate_intents` (refuse on error or `invariant_violated`), then `dry` and `mock` stop with
  `dry_run_ok` with the `mt_on_transfer` notification of each debtor (`mtNotification`: exactly the arguments Intents sends the circle);
  `mock` with an injected `deliver` sends those notifications one by one (sandbox or mock Intents), records the amount handed back or the refusal
  of each debtor, and reconciles with `readStatus`: one refusal leaves only that debtor `pending` (`mock_run`). `live` calls the injected `execute` once and reconciles every debtor to `paid` or `pending`; a debtor still `due` is never
  assumed paid.

## Verified in the Verifier source (`near/intents` `d340060`)
The intent tag is `"intent":"transfer"`; `Transfer` has `receiver_id`, `tokens`, `memo`, and the flattened `msg` and `min_gas`; the
payload has `signer_id`, `verifying_contract`, `deadline`, base64 `nonce`; a nonce of 32 bytes is `magic 5628f6c6 || version || salt || deadline
|| 15 random bytes`; `execute_intents` panics on any error, so the Intents balances move all or nothing.

## Not verified or not built, so BE-034 stays partial
1. The circle has `mt_on_transfer` since interface 0.0.9 (spec 18, contracts `35dfca5`, sandbox test `tests/be034_mt_on_transfer.rs` against a
   mock multi-token). The USDT of such a payment stays a multi-token balance at Intents until someone calls `withdraw_intents_balance`
   (permissionless, spec 18, contracts `2c63ef5`), which brings the booked amount to the NEP-141 account that `claim` pays from; until then
   the pool is booked and not backed in that account (view `intents_balance` says how much), and a `claim` that finds the balance short fails
   through the normal path and is repeated. The worker plans this call after the payments and before any claim: `dry` reports it as `planned`
   with the amount of the batch, `mock` calls the injected `withdraw` after the deliveries for what the circle kept (transfers minus refunds of the
   debtors that were paid). A run on a real circle is still to be done; the sandbox test uses a mock Intents that holds balances.
2. The status `paid` is not atomic across debtors even then: each `mt_on_transfer` is its own receipt (CT-058).
3. The NEP-413 wrapper of `MultiPayload` (`standard`, `payload`, `public_key`, `signature`) and the encoding of the nonce `deadline` were not
   checked against a live Verifier. The module reads only the signed `message`; the signer (agent or SDK) builds the nonce and signs.
4. How many debtors fit in one 300 Tgas call is not measured; 5 is a guess.
5. A run on mainnet needs the owner; `intents.testnet` has no code. Nothing here sends a transaction in `dry` or `mock`.

## Before a claim: `withdraw_intents_balance`
A residual that arrives through Intents (`mt_on_transfer`) is booked in the epoch pool at once, but the USDT stays a multi-token balance at Intents until `withdraw_intents_balance` (permissionless, interface 0.0.9) brings it to the NEP-141 account of the circle. The order for the worker, per batch:

1. `execute_intents` (live), or the deliveries of the mock; each debtor is reconciled to `paid` or `pending` from `net_position`.
2. `withdraw_intents_balance` once, with at least 130 Tgas attached (the builder of the SDK asks for 150). In `dry` the plan says `planned` with the expected amount; in `mock` the injected `withdraw` runs for what the circle kept (the transfers minus the refunds of the debtors that were paid).
3. Only then the claims. The view `intents_balance` says how much is still at Intents; `0` means nothing is waiting.

What happens if the withdrawal is not done before a claim:
- A claim to `near` is paid with `ft_transfer` from the NEP-141 balance of the circle. While the booked USDT is still at Intents, that balance is **smaller than the pool says**. If it still covers the claim, the claim is paid from the money that is there, **including the stakes of other members**, and the books close again only when the withdrawal arrives. If it does not cover the claim, `ft_transfer` fails, the claim goes the normal failed way (`residual_claim_failed`, the position is `claimable` again) and can be repeated after the withdrawal.
- A withdrawal that Intents cannot finish books nothing and can be called again (`ERR_WITHDRAW_IN_FLIGHT` while one is open, `ERR_NOTHING_TO_WITHDRAW` when nothing is booked).
- So a keeper that claims for members must call `withdraw_intents_balance` first whenever `intents_balance` is above 0. The sandbox test is `contracts/tests/be034_intents_withdraw.rs`; the real answer of `ft_withdraw` of `intents.near` is assumed from the reference contract and was not tried.


## What the indexer knows about Intents (interface 0.0.9)
The read model keeps the events `intent_posted`, `intent_removed` and `intents_withdrawn` (tables `intent_book` and `intent_withdrawals`, migration 5). Two routes read them, both per circle:

- `GET /x207/circles/{circle}/intents/hashes?status=posted|removed&account=` lists the intent hashes members posted, newest first, with paging (`limit`, `cursor`). A removed intent is not deleted: it shows under `status=removed`, so it is gone from the default list. A hash can be posted again after it was removed. A removal of a hash the indexer never saw (posted before the indexer started) is ignored.
- `GET /x207/circles/{circle}/intents/withdrawals` lists the withdrawals made by `withdraw_intents_balance`, newest first, with `totalWithdrawn` and `withdrawals` (the count).

What the events do **not** give is the balance still booked at Intents. `residual_paid` is the same event whether the debtor paid by `ft_on_transfer` or by `mt_on_transfer`, so a replay cannot tell how much of the pool sits at Intents. The only source is the view `intents_balance` of the contract. Decision (coordinator): read it through the RPC view `intents_balance` when needed; no new event in 0.0.9. `intents_credited` can be weighed again for a later version.
