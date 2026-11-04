# The read model against the circle of interface 0.0.13 on testnet (BE-079)

Circle `x207-v013.testnet` (CT-100, interface 0.0.13, `code_hash` `DTw5rUUdJSbWjD361MmBxKW4nm4ETnNkex63mfUCjsjh`, a local reproducible build of contracts `8799ebe`), run by A2 with epochs of 210 edges (15 members, 14 edges each). Read on 2026-11-04 with `node scripts/testnet-v013.mjs` (reads blocks from `https://testnet.neardata.xyz`, views from the RPC, and the transactions of the account from the index of FastNEAR; it sends no transaction and uses no key).

## Method
1. The real indexer (`Indexer`, the real handlers, `NeardataBlockSource`) follows the chain from two blocks before the first transaction of the account. Only the blocks of the transactions and the eight after them are fetched (the others have no log of the circle), because the free neardata gives 30 blocks a minute. The summary `clearing_applied` is read as in production: the indexer reads `list_obligations` before the block, checks the set against `edges_hash`, and keeps it in `clearing_edges`.
2. The read model is compared with the views of the contract: `list_members` and `member`; `get_epoch`; `list_obligations` (cumulative, last sequence, `cleared`); the kept edges against the event and against `get_proposal` (`proposal_hash`, `edge_count`); `list_positions` against the table `settlements`; and, for an epoch whose pairs are gone, `edges_unavailable`.
3. The database is kept (`READMODEL_DB`), so a later run reads only the new blocks. The run is a snapshot: the chain moves while it is read, and a difference in a phase that changed is not a bug.

## Result of the run to block 276143898 (epoch 2 committed, epoch 3 open)
| Area | Contract | Read model | Difference |
| --- | --- | --- | --- |
| members | 15 | 15 | `status`, `limit`, `pubkey_voucher` equal; **`stake` differs** (below) |
| events | 420 `voucher_registered`, 15 `member_joined`, 15 `stake_added`, 2 `epoch_cutoff`, 1 `clearing_submitted`, 1 `clearing_applied`, 1 `epoch_committed` | all 473 rows handled, none unknown | none |
| obligations, epochs 1 to 2 | 210 + 210 pairs | 210 + 210 | none: cumulative, sequence and, for epoch 2, `cleared` equal |
| epoch 2 clearing | `proposal_hash` `3dadebb9…21c9`, `edge_count` 210, `total_cleared` 210000000 | `clearing_edges.edges_hash` the same, 210 edges, `cleared_total` the same, `edges_unavailable` 0 | none |
| positions, epoch 2 | `list_positions` empty (a ring: nobody owes) | 15 rows with role `none` from the event | not a difference: the view lists only the non-zero positions |
| phase of epoch 1 | `commit` | `clearing` | not a difference: D9 has four phases; `cutoff` and `commit` come from the clock (the script maps them) |

## The difference found: the fee comes out of the stake and no event says how much
All 15 members: stake 99979000 in the contract, 100000000 in the read model. `commit_epoch` charges the fees of the epoch from the stake of the debtors (`charge_fees` in `commit.rs`): the fee `cleared_total × bps / 10000` (210000 for the clearing fee at 10 bps and 105000 for the solver at 5 bps), shared over the debtors pro rata to what they cleared (`pro_rata_fee`: floor shares, then the leftover units one by one in account order), each share at most the stake, and then `bound_limit` lowers the limit to the stake minus the locked bond. Here 315000 / 15 debtors = 21000 each.
- No event carries it. `clearing_applied` has the two totals (`clearing_fee` `"210000"`, `solver_fee` `"105000"`), `epoch_committed.positions[]` has `{account_id, net, role, status, amount, outstanding_debt}` and no stake, and no other event of the commit or the finalization names a stake (`stake_added`, `stake_withdrawn` and `member_defaulted` are the only ones; `limits_updated` has limits).
- A new event for each member does not fit the receipt: the logs of `commit_epoch` in the worst case are about 13.8 KB of the 16 KiB, and 64 members would add about 6 KB.
- Decision of the coordinator: the indexer computes the charge itself from what it has (BE-081), and this script keeps comparing the stake with the view `member` as the watch.

## What this run does not show yet
- `finalize_epoch` and a prune of an epoch of this circle (the run stopped at epoch 3 open); `edges_unavailable` after a real prune stays covered by the unit tests (TC-BE-078-F1) only.
- An epoch with a non-zero position (every epoch so far is a balanced ring), so the positions are compared only as "none".
- The comparison is at one moment, and the free neardata is slow: a run of 500 blocks takes 8 to 10 minutes.

## Run it again
```bash
npm run build
READMODEL_DB=/tmp/x207-testnet-v013.sqlite node scripts/testnet-v013.mjs x207-v013.testnet > report.json
```
