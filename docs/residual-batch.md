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
   mock multi-token). **Open question for the spec:** a payment that arrives as the Intents multi-token stays in the circle's balance at
   Intents; the circle books it in the epoch pool (D6) as if the USDT were in its own NEP-141 account, but `claim` to `near` pays with
   `ft_transfer` from that NEP-141 balance. Until the circle withdraws the multi-token to its own NEP-141 balance (a call to Intents that
   no method of the circle makes), the pool is booked and not backed in the NEP-141 account. The sandbox test cannot show this, because the mock
   holds no balance.
2. The status `paid` is not atomic across debtors even then: each `mt_on_transfer` is its own receipt (CT-058).
3. The NEP-413 wrapper of `MultiPayload` (`standard`, `payload`, `public_key`, `signature`) and the encoding of the nonce `deadline` were not
   checked against a live Verifier. The module reads only the signed `message`; the signer (agent or SDK) builds the nonce and signs.
4. How many debtors fit in one 300 Tgas call is not measured; 5 is a guess.
5. A run on mainnet needs the owner; `intents.testnet` has no code. Nothing here sends a transaction in `dry` or `mock`.
