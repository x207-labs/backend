# Indexer against near-sandbox

The test `contracts/tests/be006_indexer_e2e.rs` (umbrella checkout, `contracts` next to `backend`) runs the indexer
of this repo against a real near-sandbox chain with the real `x207-circle` wasm, then compares the read API with
the contract's own views.

Build first: `npm run build` here, `cargo near build non-reproducible-wasm` in `contracts`. Run:

```bash
cargo test --locked --test be006_indexer_e2e
```

The test starts `contracts/tests/e2e/index_chain.mjs`, which imports `dist/index.js` and follows the chain with
`RpcBlockSource` over `FailoverRpcClient` while the flow runs.

## Indexer (BE-006)
Flow: three members join and stake, six vouchers, `close_epoch`, `submit_clearing`, `commit_epoch`, the debtor does
not pay, `finalize_epoch`, the creditor claims, one member requests exit and withdraws. The indexer must handle
every event with `handled = 1` (none pending, none unknown) and name all of: `member_joined`, `stake_added`,
`voucher_registered`, `epoch_cutoff`, `clearing_submitted`, `clearing_applied`, `epoch_committed`,
`member_defaulted`, `limits_updated`, `epoch_finalized`, `residual_claimed`, `exit_requested`, `stake_withdrawn`.

Two things the run showed about `RpcBlockSource`:
- **Follow the chain live.** A sandbox forgets the outcomes of old transactions after a few epochs of height. The
  indexer has to read each block soon after it is final; replaying a finished sandbox from its first block finds
  nothing.
- **A transaction the contract signs for itself is missed.** When signer and receiver are the same account the
  receipt runs in the block that includes the transaction, and `getBlock(H)` scans transactions only up to block
  `H - 1`. The test sends permissionless calls from a separate keeper account for that reason. Real traffic never
  has the contract sign, so this is a limit and not a fix to make now.

## 207 report (BE-020, TC-BE-020-15)
After the flow, `GET /x207/circles/agents-main/epochs/1` answers `207` with `phase` `finalized`. For each member
`net` and `status` equal the contract's `net_position(1, account)`: a `null` position gives `200` and `"0"`, a
defaulted debtor `409` with `stakeSlashed`, a creditor that claimed `200` with `settlement` `claimed`.
`totalObligation` and `cleared` equal the sums of the contract's pair entries.

## Exit status (BE-039, TC-BE-039-12)
The member that requested exit in epoch 1 and withdrew after `finalize_epoch` reads `status` `exited`,
`exitRequestedEpoch` 1 and `stake` `"0"` from `GET …/members/{account}`, equal to the contract's `member` view.
`stake`, `limit` and `status` of the other members equal the view as well.
