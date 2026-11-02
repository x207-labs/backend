# BE-034: N-party residual through one `execute_intents`

Code: `src/settlement/residual/batch.ts`, tests `test/settlement/residual-batch.test.ts` (9 pass, no network). Study behind it:
`contracts/docs/ct058-atomic-residual-intents.md`.

## What is built
- `planResidualBatches(positions, { circleContract, epoch })`: one Intents `transfer` per net debtor with `receiver_id` = the circle, the USDT
  token as `nep141:<account>`, and `msg` = `{"action":"settle","epoch":N}`; zero amounts left out, calls of at most 5 debtors.
- `checkSignedPayload`: the signed message of each debtor is JSON of exactly its planned transfer (`signer_id`, `verifying_contract`, intent).
- `runResidualBatch`: check payloads, `simulate_intents` (refuse on error or `invariant_violated`), then `dry` and `mock` stop with
  `dry_run_ok`. `live` calls the injected `execute` once and reconciles every debtor to `paid` or `pending`; a debtor still `due` is never
  assumed paid.

## Verified in the Verifier source (`near/intents` `d340060`)
The intent tag is `"intent":"transfer"`; `Transfer` has `receiver_id`, `tokens`, `memo`, and the flattened `msg` and `min_gas`; the
payload has `signer_id`, `verifying_contract`, `deadline`, base64 `nonce`; a nonce of 32 bytes is `magic 5628f6c6 || version || salt || deadline
|| 15 random bytes`; `execute_intents` panics on any error, so the Intents balances move all or nothing.

## Not verified or not built, so BE-034 stays partial
1. The circle has no `mt_on_transfer`, so a real run moves USDT to the circle's Intents balance but cannot mark anybody `paid`. That is a
   contract change with an ABI bump (CT-058 sizes it) and it is not in the interface spec; no name was added here.
2. The status `paid` is not atomic across debtors even then: each `mt_on_transfer` is its own receipt (CT-058).
3. The NEP-413 wrapper of `MultiPayload` (`standard`, `payload`, `public_key`, `signature`) and the encoding of the nonce `deadline` were not
   checked against a live Verifier. The module reads only the signed `message`; the signer (agent or SDK) builds the nonce and signs.
4. How many debtors fit in one 300 Tgas call is not measured; 5 is a guess.
5. A run on mainnet needs the owner; `intents.testnet` has no code. Nothing here sends a transaction in `dry` or `mock`.
