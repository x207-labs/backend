# Interface 0.0.12 in the read model (BE-065)

The events of the bond with an arbiter (CT-094), of `freeze_member` (CT-095) and of the official contracts (CT-096) are handled by `src/indexer/handlers/rules.ts` (raw handlers: the SDK parser does not know the names; the data is the array of NEP-297, as the real chain sends it). D9 migration 9 adds `deals`, `deal_events`, `member_freezes` and `official_contracts`; `rebuildReadModel` clears and replays them.

| Event | Effect in D9 |
| --- | --- |
| `bond_locked` | opens the row of the deal (the first event names `party_a`, the second `party_b`); both locked |
| `deal_confirmed` | history only; the `bond_released` that follows unlocks |
| `bond_released` | unlocks that party; a deal with nothing locked is `closed`; a release with `reason` `ruling` bounds the limit (below) |
| `deal_disputed` | state `disputed`, complainant, accused, evidence hash, time |
| `deal_ruled` | arbiter and verdict |
| `bond_slashed` | `members.stake` of both parties set to `from_stake` and `to_stake`; the loser is unlocked; limits bounded |
| `freeze_proposed` | `member_freezes` row `pending` with `eta` and reason hash |
| `member_frozen` | `frozen`, with `from_epoch` |
| `freeze_cancelled`, `member_unfrozen` | the row is removed |
| `asset_contracts_set` | `official_contracts` row; an empty list removes it |

**Limit after a ruling.** `rule_deal` ends with `limit = min(limit, stake - bond_locked)` for both parties and, since the fix of review BE-064 C-9 (contracts `7d9d689`), emits `limits_updated` for the limits that changed. The handler of `limits_updated` writes it; when the same receipt holds `deal_ruled` the history reason is `ruling` (D9 migration 10 added the value to the `member_limits` table), otherwise `finalize`. The indexer no longer works the limit out by itself. A circle on a wasm from before that fix would show the old limit until the next `limits_updated`.

## Routes (all under `/x207/circles/{circle}`)
- `GET /deals?account=&state=open|disputed|closed|all&limit=&cursor=`: newest first; with `account` the answer has `bondLocked`, the sum of the bonds that account has locked now.
- `GET /deals/{bundleId}`: the deal and its `history`. `404 deal_not_found`. The arbiter is known after the ruling; `get_deal` of the contract gives the arbiter and `confirm_by` of a deal that is open (not read by the backend).
- `GET /freezes?state=pending|frozen`.
- `GET /members/{account}/freeze`: `{state, frozen, eta, reasonHash, fromEpoch}`; not frozen is `frozen: false` (the same as `is_frozen`), `404 member_not_found` for an unknown member.
- `GET /asset-contracts`: the official contracts per asset type.

The facilitator that refuses the vouchers of a frozen account (`is_frozen`, spec 22.2) is part of the SDK repository (`sdk/apps/facilitator`), not of this one.
