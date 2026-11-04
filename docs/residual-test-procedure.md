# Residual path test procedure (BE-026)

`intents.testnet` has no code (Spike Test Results S3.1), so the residual path cannot be tested on testnet. The order is: no network, no funds, then one small nominal transaction on mainnet after human confirmation. This document is a procedure only; the test suite runs none of these steps automatically.

Worker modes (`X207_SETTLEMENT_MODE`, see `src/settlement/config.ts`):

| Mode | Network | Funds | Used for |
| --- | --- | --- | --- |
| `mock` | no | no | Stage 1 |
| `dry` (default) | real 1Click, `dry: true` forced | no | Stages 2 and 3 |
| `live` | real 1Click, `dry: false` allowed | yes | Stage 4 only |

## Stage 1 — mock (`FX-1C`)

```bash
npm test
```

A pass means the quote mapping, errors, and withdrawal threshold are correct against the Round 3 recordings (B1.x, B2.x). Prerequisite for stage 2.

## Stage 2 — `simulate_intents` (view, no funds)

`simulate_intents` on `intents.near` is a view; it is called through `simulateIntents(view, signed)` in `src/settlement/intents.ts` with `rpcViewFunction(NEAR_RPC_PRIMARY_URL)`.

1. Prepare `signed`: a list of signed intents. For an initial probe it may be `[]` (result of S2.7: `intents_executed: []`, proving the view is reachable).
2. For a residual, the `ft_withdraw` / transfer intent is built by `OneClickClient.generateIntent(...)` and then signed by the owner's key in a wallet; the worker does not hold the key.
3. Pass when `ok: true`. `ok: false` with `code: "simulation_failed"` carries the view's error message; fix the intent, do not continue.

## Stage 3 — quote `dry: true`

Env: `X207_SETTLEMENT_MODE=dry`, `ONECLICK_BASE_URL`, `ONECLICK_JWT` (optional; without a JWT the quote gets +25 bps, but `dry` still returns 201).

Parameters already tested in Round 3:

| Direction | `depositType` | `recipientType` | Expected result |
| --- | --- | --- | --- |
| Inbound (stake / `due`) | any supported origin | `INTENTS` | 201 + `depositAddress`; destination `nep141:usdt.tether-token.near` |
| Outbound creditor | `INTENTS` | `DESTINATION_CHAIN` | 201; `withdrawFee` `"2400"` to USDC Base, `"900000"` to USDT Tron |

Mandatory rules:

- `refundTo` must be an existing account. A nonexistent account causes a 1Click internal error (R1.5). Check with `view_account` first.
- The `User-Agent` header is required; without it 1Click answers `error code: 1010`.
- A withdrawal to Base below 0.25 USD (`"250000"`) is rejected by the worker (`below_withdraw_threshold`); passing the `amountOut` from the `dry` quote to `evaluateWithdrawThreshold` yields the same estimated loss as the 1Click figure.
- No `generate-intent` / `submit-intent` at this stage.

Record `amountIn`, `amountOut`, `withdrawFee`, `timeEstimate` for each quote. A large difference from the B2.1–B2.5 table is noted in Spike Test Results before continuing.

## Stage 4 — one small nominal residual on mainnet (human confirmation)

Run only after stages 1–3 pass and the owner explicitly approves, in chat, for this transaction (amount, account, direction). A one-time approval does not apply to later transactions.

Safety limits:

- Amount: for the outbound path to Base use an amount above the threshold (e.g. 1 USDT, loss ~0.38%); for the inbound path use the smallest observable amount (e.g. 1 USDT).
- Account: a test account owned by the owner, not an account of a production circle member.
- The worker runs with `X207_SETTLEMENT_MODE=live` only for the duration of the transaction, then is set back to `dry`.
- Signing is done by the owner in a wallet. The key is not stored in the worker's `.env`.

Steps (outbound, creditor):

1. Quote `INTENTS` → `DESTINATION_CHAIN` with `dry: true`; show `withdrawFee` to the owner.
2. After the owner agrees: quote `dry: false`, `generateIntent`, the owner signs, `submitIntent`.
3. Watch `status(depositAddress)` until a final status (`SUCCESS`, `REFUNDED`, or `FAILED`).

Steps (inbound, `due` or stake): quote `recipientType: INTENTS`, the owner sends to `depositAddress`, wait for the Intents balance, then `buildFtWithdraw` (without `msg`) and `buildFtTransferCall` with `stakeMsg` / `settleMsg` (ADR-19), all signed by the owner.

## Evidence to record (in the vault, not in the repo)

Per stage: UTC date, mode, result (pass or fail), `amountIn` / `amountOut` / `withdrawFee`, and for stage 4 the tx hash and the final 1Click status. Do not record the JWT, keys, or the contents of `.env`.

BE-026 is complete when stages 1–3 pass and stage 4 succeeds once. This document is the procedure; execution of stage 4 awaits owner approval and has not been done.

## Results already run (2026-11-02, contracts team)
Stages without funds (1–3), using `X207_INTEGRATION=1 npx vitest run test/settlement` against real 1Click and mainnet RPC, always `dry: true`:
- Deposit quote for a 50 USDC Base stake and the settle quote from D9: 201, job `waiting_deposit` (TC-BE-027-12, TC-BE-032-01).
- Withdraw quote of 1 USDT to USDC Base: 201, `withdrawFee` `"2400"` (TC-BE-030-13, TC-BE-032-02).
- `simulate_intents` on `intents.near`: empty input succeeds, an invalid intent is mapped to `simulation_failed` (TC-BE-032-03).
- `refundTo` of a nonexistent NEAR account is rejected before reaching 1Click (TC-BE-032-04); unsupported asset 422, invalid address and amount too small 502 (TC-BE-032-05); no `dry: false` request during the suite (TC-BE-032-06).
- Finding: mainnet RPC answers a nonexistent account with the top-level error `UNKNOWN_ACCOUNT`; `nearAccountExists` already handles it.

Not yet run: stage 4, one small nominal residual transaction on mainnet (deposit from the origin chain, `ft_withdraw` to a NEAR account, `ft_transfer_call` to the contract, then withdrawal to USDC Base). It needs funds, the owner's key, and human confirmation; not done by worker sessions.
