# Mapping of D9 columns to D1/D2/D4/D5/D7 fields

Every column of the D9 read model (migration `src/db/migrations.ts`) is traced to a storage field in the Data Model (D1 member registry, D2 obligation ledger, D3 voucher registry, D4 clearing log, D5 settlement record, D6 stake pool, D7 parameters) or marked `teknis` (technical: keys, block pointers, receipt proofs). Spec: D9 Schema Spec section 3. Checked by `TC-BE-004-09`.

The infrastructure tables `events_raw`, `indexer_cursor`, `settlement_jobs` and `clearing_edges` are not projections of D1–D7 and are not mapped here.

`clearing_edges` (migration D9 11, BE-077) keeps the cleared edges of an epoch that the indexer read from the view `list_obligations` for a `clearing_applied` summary of interface 0.0.13 (`edge_count`, `edges_hash`). The set is checked against `edges_hash` before the block is applied, and a rebuild replays the summary from it with no RPC. If the contract no longer has the pairs of the epoch (`prune_epoch` ran before the indexer read them, B8-F1), the view lists fewer pairs than the epoch had edges: the row is kept with `unavailable` 1, `epochs.edges_unavailable` is set, `obligations.cleared` of that epoch stays NULL, and the indexer goes on (the positions come with `epoch_committed`). A full list that does not hash to `edges_hash` still stops the indexer. `epoch_committed` of 0.0.13 carries all positions (`positions_hash`, `position_count`) and is read from the event.

| Table | Column | D field | Notes |
| --- | --- | --- | --- |
| circles | circle_id | teknis | Circle key in the API path |
| circles | contract_id | teknis | `x207-circle` contract account |
| circles | network | teknis | `x207:<circle_id>` |
| members | circle_id | teknis | Multi-circle key |
| members | account_id | D1 `account_id` | |
| members | pubkey_voucher | D1 `pubkey_voucher` | |
| members | terms_hash | D1 `terms_hash` | Hash of the terms accepted at `join` |
| members | stake | D1 `stake` | Overwritten from events; lowered by the fee of a commit, which the indexer computes (BE-081, `src/indexer/fee-charges.ts`) |
| members | credit_limit | D1 `limit` | Named `credit_limit` because `LIMIT` is an SQL keyword |
| members | outstanding_debt | D2 `outstanding_debt[account]` | From `epoch_committed`, `member_defaulted` |
| members | stale | teknis | 1 when the stake or the limit could not be computed after the fee of a commit, or was found different from the view `member` and taken from it (BE-081) |
| members | fee_mismatches | teknis | How many times that happened to the member (BE-081) |
| members | status | D1 `status` | `pending`/`active`/`suspended`/`exited` (ADR-26) |
| members | admitted | D1 `admitted` | `MemberView.admitted` (admission = dao) |
| members | settled_history | D1 `settled_history` | |
| members | joined_at_ns | D1 `joined_at` | |
| members | exit_requested_epoch | D1 `exit_requested_epoch` | ADR-29 |
| members | reactivate_epoch | D1 `status` | ADR-30 (P1): epoch at which status returns to `active` |
| members | updated_block | teknis | Block of the last update |
| member_limits | id | teknis | History order |
| member_limits | circle_id | teknis | |
| member_limits | account_id | D1 `account_id` | |
| member_limits | epoch | D1 `limit` | Epoch of the limit change; NULL outside finalization |
| member_limits | old_limit | D1 `limit` | |
| member_limits | new_limit | D1 `limit` | |
| member_limits | status | D1 `status` | Member status at the time of the change |
| member_limits | reason | D1 `limit` | Cause: `stake`/`finalize`/`default` |
| member_limits | block_height | teknis | |
| member_limits | receipt_id | teknis | |
| member_limits | log_index | teknis | |
| epochs | circle_id | teknis | |
| epochs | epoch | D4 `epoch` | |
| epochs | phase | D4 `epoch` | `open`/`clearing`/`payment_window`/`finalized` |
| epochs | cutoff_at_ns | D7 `epoch_length` | Epoch cutoff from `next_cutoff_at` |
| epochs | closed_at_ns | D4 `epoch` | Time of `close_epoch` |
| epochs | proposal_deadline_ns | D7 `proposal_window` | `epoch_cutoff.proposal_deadline` (K-41) |
| epochs | committed_at_ns | D4 `epoch` | Time of `commit_epoch` |
| epochs | payment_deadline_ns | D7 `payment_window` | commit + `payment_window` |
| epochs | finalized_at_ns | D5 `status` | Time of `epoch_finalized` |
| epochs | edge_count | D2 `obligation` | Number of edges at cutoff |
| epochs | total_obligation | D2 `obligation` | Σ obligations at cutoff |
| epochs | cleared_total | D4 cleared value | |
| epochs | total_due | D2 `obligation` | Σ `amount` of the debtor positions; from `epoch_committed` (0.0.13), checked against the positions |
| epochs | edges_unavailable | teknis | 1 when the cleared edges of the epoch could not be read from the chain (pruned before the indexer read them); `obligations.cleared` of the epoch is then NULL (B8-F1) |
| epochs | total_claimable | D2 `obligation` | Σ `amount` of the creditor positions; from `epoch_committed` (0.0.13), checked against the positions |
| obligations | circle_id | teknis | |
| obligations | epoch | D2 `obligation` | |
| obligations | debtor | D2 `obligation` | Key `(debtor, creditor)` |
| obligations | creditor | D2 `obligation` | |
| obligations | seq | D3 `seq` | Last registered voucher |
| obligations | cumulative_amount | D2 `obligation` | Obligation before clearing (ADR-17) |
| obligations | cleared | D4 cleared value | NULL until `clearing_applied`; in 0.0.13 from `clearing_edges` (`list_obligations`) |
| obligations | registration_mode | D3 `seq` | `cumulative`/`per_request` |
| obligations | registered_block | teknis | |
| obligations | receipt_id | teknis | |
| clearing_log | circle_id | teknis | |
| clearing_log | epoch | D4 `epoch` | |
| clearing_log | solver | D4 `solver` | |
| clearing_log | cleared_total | D4 cleared value | |
| clearing_log | fee | D7 `fees` | `clearing_fee + solver_fee` |
| clearing_log | edge_count | D4 proposal `edges` | Edges with `cleared > 0` |
| clearing_log | block_height | teknis | |
| clearing_log | applied_at_ns | D4 `epoch` | Time the proposal was applied |
| clearing_log | tx_hash | teknis | Tx hash from the indexer |
| clearing_log | receipt_id | teknis | |
| settlements | circle_id | teknis | |
| settlements | epoch | D5 `net_position[epoch]` | |
| settlements | account_id | D5 `net_position[epoch][account]` | |
| settlements | role | D5 `net_position` | `debtor`/`creditor`/`none` |
| settlements | net | D5 `net_position` | Signed: negative = net debtor |
| settlements | amount | D5 `net_position` | `|net|` |
| settlements | cleared | D4 cleared value | Σ cleared on the member's incoming edges |
| settlements | status | D5 `status` | `due`/`paid`/`defaulted`/`claimable`/`claimed` (ADR-26) |
| settlements | due_at_ns | D7 `payment_window` | Payment deadline |
| settlements | paid_amount | D5 `status` | Amount paid (`residual_paid`) |
| settlements | stake_slashed | D6 stake | `member_defaulted.from_stake` |
| settlements | reserve_used | D6 reserve | `member_defaulted.from_reserve` |
| settlements | shortfall | D5 `status` | `member_defaulted.shortfall` |
| settlements | haircut | D5 `status` | 0 while limit ≤ stake |
| settlements | destination | D5 `status` | `ClaimDestination` `near`/`intents` |
| settlements | tx_hash | teknis | Tx hash from the indexer (ADR-32 K-15) |
| settlements | updated_block | D5 `updated_at_block` | |
| params | id | teknis | History order |
| params | circle_id | teknis | |
| params | field | D7 field name | Including `proposal_window`, `limit_cap`, `limit_decay` |
| params | old_value | D7 old value | NULL for the initial row |
| params | new_value | D7 new value | JSON |
| params | effective_epoch | D7 `effective_epoch` | |
| params | block_height | teknis | |
| params | receipt_id | teknis | `init:<block>` for the initial row |
| params | log_index | teknis | |

## escrows (migrations 4 and 6, CT-075 and CT-090)
One row per class A escrow, key `(circle_id, grant_id)`. `kind` `nft` fills `nft_contract` and `token_id`; `kind` `ft` (event `ft_escrow_held`, interface 0.0.10) fills `ft_contract` and `amount`; `kind` `mt` (event `mt_escrow_held`, CT-092, migration 7) fills `mt_contract`, `token_id` and `amount`. `amount` is decimal text in the units of that token (not credit) because 18-decimal tokens pass 2^63; the 2^63 bound check at ingest does not apply to these two events, and the handler checks 1..2^128-1. `state` moves through `grant_activated` (delivered), `grant_revoked` (cancelled) and `escrow_failed` (held or stuck), the same for all kinds. Read API: `escrow` on `GET …/grants` and `…/grants/{id}` holds `{kind:"nft", nftContract, tokenId, state}`, `{kind:"ft", ftContract, amount, state}` or `{kind:"mt", mtContract, tokenId, amount, state}`.

## intent_book and intent_withdrawals (migration 5, BE-045)
`intent_book`: intent hash per circle with `status` `posted` or `removed`. `intent_withdrawals`: one row per `intents_withdrawn`.
