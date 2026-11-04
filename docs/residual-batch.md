# BE-034: N-party residual through one `execute_intents`

Code: `src/settlement/residual/batch.ts`, tests `test/settlement/residual-batch.test.ts` (12 pass, no network). Study behind it:
`contracts/docs/ct058-atomic-residual-intents.md`.

## What is built (the worker side)
- `planResidualBatches(positions, { circleContract, epoch })`: one Intents `transfer` per net debtor with `receiver_id` = the circle, the USDT
  token as `nep141:<account>`, `msg` = `{"action":"settle","epoch":N}` and `min_gas` of 10 Tgas; zero amounts left out, calls of at most 8 debtors (measured, see below).
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

## Run against the real Intents contract in near-sandbox (BE-034, CT-103)
`tests/residual-batch.sandbox.test.ts` of the umbrella runs the wasm of `intents.near` from mainnet (`contracts/scripts/fetch-intents-wasm.sh`, sha256 checked) as the `intents_id` of a circle. Three net debtors (12, 9 and 7 credit) owe one creditor, and the test follows the balances at each step:
1. Each debtor deposits its residual to Intents (`ft_transfer_call` with its own account as `msg`: a multi-token balance) and registers the ed25519 key that will sign (`add_public_key`, 1 yocto).
2. `planResidualBatches` makes one `transfer` per debtor (receiver = the circle, token `nep141:<usdt>`, `msg` = `{"action":"settle","epoch":N}`); each debtor signs its own transfer.
3. `runResidualBatch` in `live` mode checks every payload, `simulate_intents` passes on the real Verifier (a payload whose signed text was changed is refused there: nothing moves), then the relayer sends ONE `execute_intents`.
4. Result: the three balances of the debtors at Intents are 0, the circle holds 28 credit at Intents, `intents_balance` of the circle says 28, the NEP-141 balance of the circle did not change, and the three positions are `paid` (each `mt_on_transfer` is its own receipt; the worker reconciles from `list_positions`).
5. After `finalize_epoch`, `withdraw_intents_balance` brings the 28 credit to the NEP-141 account of the circle (`intents_balance` 0, balance at Intents 0) and the creditor claims them.

**The signature flow of N debtors.** Every debtor signs its own payload; there is no joint signature. The worker collects N `MultiPayload` and sends them in one `execute_intents(signed)`; it holds no key. A payload (verified against the real Verifier):
- `{"standard": "nep413", "payload": {"message": <JSON text>, "nonce": <base64, 32 bytes>, "recipient": <the Verifier account>}, "public_key": "ed25519:…", "signature": "ed25519:…"}`;
- the signature is ed25519 over the NEP-413 hash of `message`, `nonce` and `recipient` (`nep413SigningHash` of the SDK, `callback_url` none), by a key that the debtor registered at Intents with `add_public_key`;
- `message` = `{"signer_id": <debtor>, "verifying_contract": <Verifier>, "deadline": <ISO time>, "nonce": <the same base64>, "intents": [<the transfer>]}`;
- the nonce is a versioned one (near/intents `nonce/versioned.rs`): `5628f6c6 ‖ 00 ‖ salt (4 bytes, view `current_salt`) ‖ deadline (8 bytes, a borsh i64 of nanoseconds, little endian) ‖ 15 random bytes`. The deadline inside the nonce must not be before the `deadline` of the message (`deadline is greater than nonce` otherwise).
`simulateIntents` takes the Verifier from the run (`verifier`), not only `intents.near`, so the same code runs on the sandbox account.

## Gas of one `execute_intents` for N debtors (measured in near-sandbox, 2026-11-04)
`tests/residual-batch-gas.sandbox.test.ts` runs one circle for each N with the wasm of `intents.near`, N debtors who each deposited their residual and signed their transfer, and ONE `execute_intents` with the most gas one call can carry (300 Tgas attached). It reads the whole transaction (`EXPERIMENTAL_tx_status`). Gas in Tgas; "Intents" is the receipt of `execute_intents` (the N signatures and the N transfers), "circle" is one `mt_on_transfer` receipt on the circle.

| N | `min_gas` of each transfer | all N paid | burnt in the receipt of Intents | burnt by one circle receipt | burnt in all receipts |
| --- | --- | --- | --- | --- | --- |
| 2 | Intents default | yes | 8.1 | 2.9 to 3.0 | 21.3 |
| 3 | Intents default | yes | 10.7 | 2.9 to 3.0 | 30.0 |
| 5 | Intents default | yes | 15.7 | 2.9 to 3.0 | 47.6 |
| 6 | Intents default | yes | 18.2 | 2.9 to 3.0 | 56.3 |
| 7 | Intents default | **no**: `Exceeded the prepaid gas.` | n/a | n/a | n/a |
| 8 | Intents default | **no**: `Exceeded the prepaid gas.` | n/a | n/a | n/a |
| 12 | Intents default | **no**: `Exceeded the prepaid gas.` | n/a | n/a | n/a |
| 8 | 10 Tgas | yes | 23.3 | 2.9 to 3.0 | 74.0 |
| 9 | 10 Tgas | yes | 25.8 | 2.9 to 3.0 | 82.7 |
| 10 | 10 Tgas | yes | 28.3 | 2.9 to 3.0 | 91.5 |
| 12 | 10 Tgas | **no**: `Exceeded the prepaid gas.` | n/a | n/a | n/a |

What the numbers say:
- What is burnt is small: about 2.5 Tgas for each debtor in the Intents receipt and about 2.9 Tgas for each `mt_on_transfer` on the circle, 91.5 Tgas for ten debtors. What limits N is not the burnt gas but the gas that Intents **reserves** for the notification of each transfer (`min_gas`), which has to fit in the 300 Tgas that the call carries. With the default of Intents the reservation allows 6 debtors (7 fail); with `min_gas` of 10 Tgas (more than three times what the circle burns) it allows 10 (12 fail; 11 was not tried).
- Failing is all or nothing: a call that exceeds the prepaid gas pays nobody, the debtors keep their balance at Intents and the same batch can be sent again with fewer debtors.
- The limit in use, `DEFAULT_MAX_PER_CALL` in `src/settlement/residual/batch.ts`, is **8 debtors** with `min_gas` of 10 Tgas (`DEFAULT_MIN_GAS`, set by `planResidualBatches` in each signed transfer): two debtors below the highest N that worked (10). Without `min_gas` the safe number would be 4. A circle whose `mt_on_transfer` burns more (a different contract) needs its own measurement.
- These are sandbox figures with the wasm of `intents.near` of block 222990644 (sha256 in `contracts/scripts/fetch-intents-wasm.sh`); the gas costs of mainnet can differ with the version of Intents and with the contents of the receipts. The circle contract burns the same on every network.

## Not verified or not built, so BE-034 stays partial
1. The circle has `mt_on_transfer` since interface 0.0.9 (spec 18, contracts `35dfca5`, sandbox test `tests/be034_mt_on_transfer.rs` against a
   mock multi-token). The USDT of such a payment stays a multi-token balance at Intents until someone calls `withdraw_intents_balance`
   (permissionless, spec 18, contracts `2c63ef5`), which brings the booked amount to the NEP-141 account that `claim` pays from; until then
   the pool is booked and not backed in that account (view `intents_balance` says how much), and a `claim` that finds the balance short fails
   through the normal path and is repeated. The worker plans this call after the payments and before any claim: `dry` reports it as `planned`
   with the amount of the batch, `mock` calls the injected `withdraw` after the deliveries for what the circle kept (transfers minus refunds of the
   debtors that were paid). A run on a real circle is still to be done; the sandbox test uses a mock Intents that holds balances.
2. The status `paid` is not atomic across debtors even then: each `mt_on_transfer` is its own receipt (CT-058).
3. The NEP-413 wrapper of `MultiPayload` and the nonce are now checked against the real Verifier in near-sandbox (see above); not on mainnet. The module reads only the signed `message`; the signer (agent or SDK) builds the nonce and signs.
4. How many debtors fit in one 300 Tgas call is measured now (next section); a run with more debtors than the table shows was not made.
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

What the events do **not** give is the balance still booked at Intents. `residual_paid` is the same event whether the debtor paid by `ft_on_transfer` or by `mt_on_transfer`, so a replay cannot tell how much of the pool sits at Intents. The only source is the view `intents_balance` of the contract. Decision (project lead): read it through the RPC view `intents_balance` when needed; no new event in 0.0.9. `intents_credited` can be weighed again for a later version.
