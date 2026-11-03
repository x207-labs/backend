# The read model against a real circle on testnet (BE-067)

Circle `x207-b1-v011.testnet` (UM-084, wasm release v0.0.11, interface 0.0.11), deployed by the transaction `A728oChvbdwZ9NVfvgDnx9NVxMrAsLL73hCDK6gar6Wv`. Run on 2026-11-03 with `node scripts/testnet-readmodel.mjs` (the script is in the repo; it reads blocks and views only, no transaction and no key).

## Method
1. The real indexer (`Indexer` with `NeardataBlockSource` over `https://testnet.neardata.xyz`, the real handlers) follows the chain from two blocks before the deploy (`276044468`) to the last transaction of the index of FastNEAR (`tx.test.fastnear.com`, 56 transactions touching the account, the last at block `276045150`) plus 30 blocks (`276045180`). The index was read before and after the run and had the same 56 transactions, so nothing came after the block that was read to. The free neardata gives 30 blocks a minute; the script asks one block every 2.1 s and waits on a 429, so the run takes 25 minutes. The database is kept in a file (`/tmp/x207-testnet-readmodel.sqlite`), so a second comparison does not read the chain again.
2. The read model (the database and the read API served from it) is compared with the views of the contract:
   - members: `list_members`, `member`, `outstanding_debt` against `GET /members` and the table `members` (status, stake, limit, outstanding debt, voucher key, terms hash, join time, admitted, settled history, exit epoch);
   - grants: `get_grant` for every id against the table `grants` (grantor, grantee, class, asset type, unit, unit price, status, expiry, delivery key) and `GET /grants`;
   - escrows: `get_escrow`, `get_ft_escrow`, `get_mt_escrow` against the table `escrows` (state, contract, token, amount) and the set of grants that have one;
   - epochs and obligations: `get_epoch`, `list_obligations` against the table `epochs`, the API `GET /epochs`, and the table `obligations` (cumulative, last sequence);
   - events: the 86 transactions of the batch file `docs/testnet-batch1.json` are read again with `EXPERIMENTAL_tx_status` and the `EVENT_JSON` logs of the circle are compared per transaction with `events_raw` (by name); every row of `events_raw` must be `handled = 1`.

## Result
| Area | Contract | Read model | Difference |
| --- | --- | --- | --- |
| members | 2 | 2 | none (after the fix of the script, see below) |
| grants | 13 | 13 (API lists 13) | none |
| escrows | 10 (5 nft, 3 ft, 2 mt), all `delivered` | 10, all `delivered` | none |
| epochs | 1 (`open`) | 1 (`open`) | `cutoff_at` of epoch 1 (explained) |
| obligations of epoch 1 | 1 (`10000000`, sequence 10) | 1 | none |
| events | 57 logs in 86 transactions | 57 rows, 0 not handled | none (same names, per transaction) |

The 57 events: `asset_class_set` 10, `escrow_held` 5, `ft_escrow_held` 3, `mt_escrow_held` 2, `grant_offered` 13, `grant_activated` 10, `member_joined` 2, `stake_added` 2, `voucher_registered` 10.

## The differences found, and what was done
1. **`joined_at_ns` of both members differed in the last digits** (`…575842` against `…575800`). The value in the database was exact (`sqlite3` shows `1793706434591575842`): the script read it as a JavaScript number. Fixed in the script (`CAST(… AS TEXT)`); not a defect of the read model.
2. **An open epoch had `edgeCount` and `totalObligation` null in `GET /epochs`**, while `get_epoch` of the contract shows the live ones (`edge_count 1`, `total_obligation 10000000`). The row gets these two only from the event `epoch_cutoff`. **Fixed** in `src/api/routes/epochs.ts`: for an open epoch that has obligations they are counted from the table `obligations` (null while there are none); a closed epoch keeps what the event wrote. Test `TC-BE-067-01`.
3. **`cutoffAt` of epoch 1 is null in the read model** (the contract says `1793792706661244007`). Explained, not fixed: epoch 1 opens in the call `new`, which emits no event, and the cutoff of every later epoch arrives in the `next_cutoff_at` of `epoch_cutoff` of the epoch before. The value can be read from the view `get_epoch` (the marketplace already does it for the open epoch, `chainView`). A fix would give the indexer a read of `get_epoch(1)` at bootstrap; it was not made because it changes the interface of the indexer for one field of one epoch. Open if the frontend needs the countdown of epoch 1 from the read API.

## What this run does not show
- Only the events that this circle produced were compared (9 kinds, batch 1: grants, escrows, one voucher per grant). Nothing was cleared: no `epoch_cutoff`, `clearing_applied`, `epoch_committed`, `epoch_finalized`, no claims, no default, no deals. Those handlers are covered by the sandbox tests of BE-006, BE-055 and BE-065, not by this circle.
- The release is 0.0.11; the events of 0.0.12 (bond, deal, freeze) do not exist on this circle.
- The comparison is at one moment (the end of the run). A later divergence is not seen.
- The events are compared by name and by transaction, not field by field (the fields are compared through the state they build: members, grants, escrows, obligations).
- Intents are a mock (`mock_mt`), as in `x207 - Deployment Testnet.md`.

## Run it again
```bash
npm run build
node scripts/testnet-readmodel.mjs [contract] [deploy-tx-hash] [batch-file]
```
It prints a JSON report with the counts and `diffs`; `diffs` is empty or explained when the read model agrees. Delete `/tmp/x207-testnet-readmodel.sqlite` to read the chain again (25 minutes), keep it to compare again at once.
