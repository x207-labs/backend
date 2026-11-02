# BE-037: confidential settlement of the residual (research)

Research note. Nothing is built. Sources: the local mirrors in the vault `99 Sources/NEAR Intents Docs/` (pages `integration/market-makers/confidential-intents`
and `integration/distribution-channels/1click-api/quickstart/confidential-swaps`, scraped 2026-10-25, not fetched again today) and the code of
`backend/src/settlement`. What the mirrors do not say is marked **not verified**.

## What Confidential Intents is (from the mirrors)
- Two chains: NEAR (public, `intents.near`) and FAR, a permissioned private fork of NEAR operated by a small validator set with a private RPC, where
  `intents.far` executes swaps on shielded balances. Swaps settle on FAR with a `token_diff` and are not visible to public indexers.
- Shield moves tokens to a Treasury account on NEAR and mints IMT tokens on FAR; unshield burns IMT and releases the Treasury tokens. Asset ids look
  like `imt:<treasury account>:nep141:<token>`. The bridge is request driven and is called the Private PoA Bridge.
- It has its own relay and needs a partner JWT; intents use a versioned nonce (salt and deadline) built with `VersionedNonceBuilder` of
  `@defuse-protocol/intents-sdk`.
- For an integrator of 1Click there are two paths: a **foreign-to-foreign swap** with `"confidentiality": "basic" | "advanced"` in the quote request
  (the user deposits and receives on external chains as usual; deposit and withdrawal cannot be linked), and an **embedded balance** with
  `depositType` / `recipientType` / `refundType` = `CONFIDENTIAL_INTENTS` and signed intent execution.
- Which of the two levels (`basic`, `advanced`) hides what is **not verified** in the mirror.

## What x207 would hide, and what it cannot
Today the residual leaves x207 in two steps (ADR-19): the creditor `claim`s USDT to its own NEAR account or to its Intents balance on the contract
(`destination`), then the backend worker withdraws or swaps with 1Click (`dry`, `mock`, `live`). The public parts are:
- the claim: `residual_claimed` event with account and amount on NEAR (public, and it must stay readable for the indexer);
- the deposit address and swap on 1Click.
Confidentiality can only cover the second step: the swap or payout from the creditor's balance to its destination chain. The ledger itself (D2, D5,
the claim amounts) is public by design, so a creditor's net position is already visible. This matches the note in the vault that confidential
settlement is outside x402 until it supports confidential transactions.

## Design of a path (proposal, untested)
1. **Quote.** Add an optional `confidentiality` (`basic` | `advanced`) to the withdraw quote of `settlement/withdraw` and pass it to the 1Click quote
   request; keep `dry: true` outside `live`. This is a small change in `quote.ts` and the request type.
2. **Foreign-to-foreign only.** The creditor's USDT is first withdrawn from the Intents balance to a deposit address (as in BE-029), and the confidential
   swap pays out on the destination chain. This needs no signed-intent execution and no FAR account.
3. **Embedded balance (later).** A creditor with a Confidential Intents balance would have the claim go `destination: intents` and then shield with a
   quote of `depositType: INTENTS`, `recipientType: CONFIDENTIAL_INTENTS`. This needs signed intents and a user-session token for balances
   (`GET /v0/account/balances` is said to need one); the worker holds no keys, so the signing must be on the creditor's side.

## Limits and risks
- Public claim amount: a payout of exactly the claim amount links the on-chain claim to the payout by amount and time; some mixing of amounts or delay
  would be needed. Not studied.
- FAR is permissioned and operated by a few validators; trust moves from the public chain to that set. The mirror says so for validators.
- Needs partner access (JWT) for the private relay; the quote path uses the same JWT as 1Click.
- `intents.testnet` has no code, and the confidentiality parameter has no testnet; the only way to try it is `dry: true` against the live 1Click, or mainnet.
- The mirrors were scraped on 2026-10-25 and the feature dates in them (parameter added 2026-07-01, B2B launch 2026-07-13, from the vault notes) were not
  re-checked.

## Verdict
Feasible for the payout step with a `confidentiality` flag on the quote (small), not for hiding the ledger. Testable only as `dry` quotes until the
owner approves a mainnet run.
