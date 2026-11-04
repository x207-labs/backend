# Security review of the contract 0.0.12 (BE-064)

**Status: complete (parts 1 and 2).** Reviewed: CT-095 (`freeze_member`, commit `f4c0d22`, `x207-circle/src/freeze.rs` and its call sites), CT-096 (official contracts per asset type, commit `11d8968`, `asset_contracts.rs` and its call sites) and CT-094 (bonds, deals, arbiter, commit `dff27e4`: `deal.rs`, and its changes in `bundle.rs`, `stake.rs`, `settlement.rs`, `commit.rs`, `member.rs`, `params.rs`, `state.rs`). Read only: nothing in `repos/x207/contracts` was changed. No test was run for this part: the findings come from reading the code at the commits above; each has the steps of a scenario that can be turned into a test in `tests/` or a unit test in the module. Levels as in `security-review-batch2.md`.

## Summary of part 1
| # | Level | Where | Finding |
| --- | --- | --- | --- |
| C1 | Medium | `asset_contracts.rs`, `escrow.rs:314` (`complete_escrow`) | A token already held in escrow when the list of official contracts is set stays for sale: the list does not stop the fake that it was made for |
| C2 | Low | `freeze.rs:100-108` | `apply_freeze` records `current_epoch`; after `close_epoch` that is the NEW epoch, so a freeze applied during clearing lets the whole next epoch register |
| C3 | Low | `freeze.rs:17,46`, `prune.rs` | The freeze record is a raw key that nothing removes when the member exits or is pruned; a member who joins again under the same account starts frozen |
| C4 | Info | `freeze.rs:73` | A pending freeze blocks nothing and is not visible to the other side of a voucher |
| C5 | Info | `asset_contracts.rs:28-31` | An empty list is "any contract": the protection is off until the DAO acts |
Checked and sound: owner-only on `propose_freeze`, `cancel_freeze`, `unfreeze_member`, `set_asset_contracts`; the timelock uses `block_timestamp` (nanoseconds) and `apply_freeze` cannot run before `eta`; `unfreeze_member` is at once and needs a `FROZEN` record, `cancel_freeze` needs a `PENDING` one; a frozen account is refused at `post_intent`, `commit_bundle` (every participant), `offer_grant`, `accept_grant`, `complete_escrow` (buyer) and by `register_with` for the payer and the payee from the epoch after the freeze; a frozen account can still pay, claim, add stake and leave (the design), and its exit path is the same `request_exit` / `withdraw_stake` (the stake leaves only after the exit epoch is finalized and the debt is 0, `stake.rs:214-236`); a new `StorageKey::AssetContracts = b'w'` was added at the end with an explicit byte, so no stored key moved; `set_asset_contracts` takes only class A types, at most 16 distinct accounts; the three receivers (`nft_on_transfer` `escrow.rs:282`, `ft` `escrow.rs:506`, `mt_on_transfer` `escrow.rs:481`) and `offer_grant` (`grant.rs:360`) all check the list, with the contract taken from the predecessor of the call (not from the message).

## C1 (Medium): the list does not reach an escrow that is already held
`asset_contracts.rs` header: "An escrow that is already held is not touched by a change of the list." The list exists against "a fake token with the right name". The sequence the list is for: a fake NFT or FT is put in escrow under a real-looking `asset_type`; the DAO notices and sets the list; the escrow is still `Held`, and `complete_escrow` (`escrow.rs:314`) never asks `is_official`, so a buyer still pays the grantor and receives the fake.
Scenario: (1) no list for `token:nep141`; (2) a grantor offers a grant with `ft_contract = fake-usdc.near` and funds the escrow; (3) the owner calls `set_asset_contracts("token:nep141", ["usdc.near"])`; (4) a buyer calls `complete_escrow(grant_id, voucher, sig)`: it succeeds, the buyer gets `fake-usdc.near`. Expected after the fix: `ERR_CONTRACT_NOT_OFFICIAL`.
Fix: in `complete_escrow`, after the escrow is loaded, require `is_official(&grant.asset_type, &escrow_contract)` for all three shapes. This does not touch what the grantor owns: `cancel_escrow` is not changed, so the grantor takes the token back. Add a case to `ct096` tests: list set after the deposit.

## C2 (Low): the freeze is late by one epoch when it is applied during clearing
`apply_freeze` stores `from_epoch = self.current_epoch` (`freeze.rs:105`). `close_epoch` sets `current_epoch = next` (`clearing.rs:248`) at the cutoff, so from then on `current_epoch` is the new open epoch although the old one is still clearing. `assert_not_frozen_for_voucher` lets any voucher with `voucher_epoch <= from_epoch` through (`freeze.rs:75`), so a freeze applied while epoch E clears has `from_epoch = E+1` and every voucher of E+1 registers, until the cutoff of E+1. The freeze bites from E+2. The comment of the module promises "from the next epoch on".
Scenario: the member has a pending freeze with `eta` in the middle of the clearing of E; someone calls `apply_freeze` then; the member registers a voucher of epoch E+1 as payer up to its limit: accepted.
Impact: bounded by one epoch and the limit of the member, on top of the 24 hours of the timelock. Fix: `from_epoch = current_epoch` only when the open epoch is the one in which the freeze is applied, and `current_epoch - 1` when the previous epoch is not finalized yet; or simpler, say in the docs that the freeze takes effect one epoch later than the one of `eta` at the worst and put `from_epoch` in `member_frozen` (it already is).

## C3 (Low): stale freeze records
The record is `x207_freeze:<account>` in raw storage (`freeze.rs:17`). Nothing deletes it when the member exits (`withdraw_stake`) or when the member is removed from the member maps. The storage stays (a small amount, paid by the contract), and an account that exits and joins again later is frozen without a new proposal, with `from_epoch` of the old freeze (so every voucher of a new epoch is refused). The owner can lift it with `unfreeze_member`, so this is a surprise, not a lock.
Fix: remove the record when the member reaches `Exited`, or check the record against the `joined_at` of the member (a freeze older than the join is void).

## C4 (Info): a pending freeze is invisible to the vouchers
`member_is_frozen` is false while pending, and `register_with` does not look at a pending record. This is the design (the 24 hours are the warning to the member), and a counterparty can read `get_freeze` before it sells on credit. Worth saying in the guide for sellers: before handing over goods to a member on credit, read `get_freeze`.

## C5 (Info): empty list means no protection
`is_official` returns `true` when the list is empty (`asset_contracts.rs:28`). That is the requested behaviour (the old one) and the tests keep it. Note for the DAO: a list that is cleared by mistake (`set_asset_contracts(type, [])`) switches the protection off at once and without a timelock, unlike `freeze_member`. Consider the same 24-hour delay for clearing a list, or an event that the backend shows (the event `asset_contracts_set` already exists with the new list).

## Part 2: CT-094 (bonds, deals, arbiter), commit `dff27e4`

### Summary of part 2
| # | Level | Where | Finding |
| --- | --- | --- | --- |
| C-6 | Medium | `commit.rs:69-71` (`charge_fees`) | The limit is cut to `stake`, not to `stake - bond_locked`: a fee charge breaks the invariant that the whole design stands on |
| C-7 | Medium | `settlement.rs:206-222` (`default_debtor`), `deal.rs:205-209` (`slash_bond`) | A default takes `due.min(stake)` from the whole stake, bonds included; then `rule_deal` panics on `checked_sub(...).expect(...)` and the verdict is lost: an accused can dodge a guilty verdict by defaulting |
| C-8 | Medium | `deal.rs:263-277`, `deal.rs:299-304` | A dispute costs nothing once the complainant's own bond is released: after A confirms that C delivered, C can accuse A at no risk |
| C-9 | Low | `deal.rs:219-225`, `events.rs` | `rule_deal` lowers limits without a `limits_updated` event, and the new events are not known to the SDK or to the indexer: the read model keeps the old stake and limit after `bond_slashed` |
| C-10 | Low | `deal.rs:268`, `deal.rs:323` | At `now == confirm_by` both `dispute_deal` (`<=`) and `settle_deal` (`>=`) are allowed: the order of the transactions decides |
| C-11 | Info | `bundle.rs` (`ERR_BOND_REQUIRED`) | The bond is avoided by splitting a swap below `bond_threshold`, or by a ring of three: by design, to be said in the guide |
| C-12 | Info | `deal.rs:319` | Nothing ends "by itself": a bond stays locked (and the exit with it) until somebody calls `settle_deal`; the member itself can |

### C-6 (Medium): `charge_fees` breaks `limit <= stake - bond_locked`
The note says "at all times `limit(m) <= stake(m) - bond_locked(m)`". Every place that sets a limit now goes through `bound_limit` (`member.rs:67`, `stake.rs:56,280`, `settlement.rs:263`), except `charge_fees` (`commit.rs:69-71`): it takes the P1 fees from the stake of the debtors of cleared edges and then does `member.limit = member.limit.min(member.stake)`.
Scenario: stake 1000, limit 800, one bond of 200 (slack 200 at the lock). Fees of 100 are charged: stake 900, limit stays 800, but `stake - bond_locked` is 700. The invariant is now false, and a default of 800 later takes the stake below the bond (C-7). Needs a circle with `clearing_fee_bps` or `solver_fee_bps` above 0.
Fix: `member.limit = bound_limit(member.limit, member.stake, &account)` there; test: a fee charge with a locked bond keeps `limit <= stake - bond_locked`.

### C-7 (Medium): a default can eat a bond, and then the verdict panics
`default_debtor` (`settlement.rs:206-222`) takes `from_stake = due.min(stake)` from the whole stake and does not look at `bond_locked`. The note's argument ("because `outstanding_debt <= limit <= stake - bond_locked`, a default never touches a bond") fails when the limit was lowered below the debt (decay, new params, C-6) or when the debt is above the limit for another reason. After such a default `stake` can be below `bond_locked`. Then `rule_deal` with `accused_guilty` calls `slash_bond`, which does `f.stake.checked_sub(amount).expect("a bond is always inside the stake")` (`deal.rs:208`): it panics, the arbiter cannot rule, and after 7 days `settle_deal` releases both bonds.
Attack (a party that is going to default anyway): A is accused by C. Before the ruling, A lets a position default so that `stake < bond`. The arbiter's `rule_deal(accused_guilty)` panics for good; C loses the bond that was the protection of the swap. The panic is the weak point: a ruling must never be impossible.
Fix: (1) `slash_bond` takes `amount.min(stake)` and emits what it moved, never panics; (2) in `default_debtor`, a locked bond is paid out first to the deal it belongs to or the default takes only `stake - bond_locked` and leaves the rest as a claim; the simpler rule is (1) plus C-6 and a test that a default of a member with a locked bond keeps the verdict possible.

### C-8 (Medium): a complaint with no risk
`dispute_deal` requires the bond of the ACCUSED to be still locked (`deal.locked[1 - me]`), but not that of the complainant. A bond is released by the confirmation of the OTHER party. If A confirms that C delivered (`confirm_deal` by A releases the bond of C), C's bond is gone; C may then dispute A. If the arbiter rules `complaint_false`, `if deal.locked[c]` is false and nothing is slashed (`deal.rs:299-301`): the false complaint is free. It also locks A's bond for up to the dispute window plus 7 days, and A cannot confirm any more once the deal is disputed.
Fix: require `deal.locked[me]` in `dispute_deal` (a party that has no bond at risk cannot accuse), or let a released complainant lose the right to dispute.

### C-9 (Low): limits and events
The note promises `limits_updated` for the loser; `bound_member_limit` (`deal.rs:220-225`) changes the limit and emits nothing. The events `bond_locked`, `deal_confirmed`, `deal_disputed`, `deal_ruled`, `bond_slashed`, `bond_released` are not in `X207EventMap` of the SDK nor in the handlers of the indexer (`backend/src/indexer/indexer.ts`): they are stored as unknown events and `stake` and `credit_limit` of the read model stay at their old values after a slash. Fix: SDK events (sdk and frontend team) and handlers `bond_slashed` (stake of both), plus `limits_updated` from the contract (A2); until then the read API is wrong for a member that won or lost a bond.

### C-10 (Low): the boundary of the window
`dispute_deal` allows `now <= confirm_by` (`deal.rs:268`), `settle_deal` allows `now >= confirm_by` (`deal.rs:323`). In the block of `confirm_by` both are valid; whoever is first wins, and a settle there ends the right to dispute. Fix: `dispute_deal` requires `now < confirm_by`.

### C-11 and C-12 (Info)
- C-11: a swap is bonded only with exactly two participants and a value at or above `bond_threshold` (`bundle.rs`). Two swaps of 60 credit instead of one of 120, or a ring of three, carry no bond. The threshold is a rule for the large swap, not a guarantee; the note says so for rings (open question 1), not for splitting.
- C-12: `settle_deal` is permissionless but nobody is paid for it. The note says the deals "end by themselves"; they end when someone calls it. The member who wants to leave can.

### Checked and sound (CT-094)
- The invariant is kept by `bound_limit` at join (`member.rs:67`), `add_stake` (`stake.rs:56`), the restore after a failed withdraw (`stake.rs:280`) and the growth at `finalize_epoch` (`settlement.rs:263`); `request_exit` and `withdraw_stake` refuse while a bond is locked (`stake.rs:202,218`, `ERR_BOND_LOCKED`).
- `open_deal` checks everything before it writes: arbiter not the owner, the circle or a party; the window between 1 hour and 14 days; the slack (`stake - limit - locked`) for both parties; at most 8 open deals per member.
- The bond is `value * bond_bps / 10_000` with an overflow fallback, and a bond that rounds to 0 is refused; `bond_threshold` 10 to 1,000,000 credit and `bond_bps` 500 to 5000 are validated.
- `terms_hash` of a bundle without an arbiter is unchanged (the three keys are appended only when present), and `confirm_by` is a string in the terms.
- The money moves only between the stakes of the two parties (`total_stake` is unchanged), by the verdict of the arbiter named in the signed terms; `no_fault` and the silence of the arbiter release both bonds; a verdict after 7 days is refused (`ERR_RULING_WINDOW`).
- `StorageKey::Deals = b'd'` is a new byte (no reuse); the two rules are in a raw key `x207_rules` that reads as the defaults when absent, so a state of 0.0.11 reads as before (the test `ct094_upgrade_from_0_0_11` of contracts team covers the upgrade); the join deposit went to 0.35 NEAR to pay for 8 open deals and a freeze record.
- Freeze: a frozen member still `confirm_deal`, `dispute_deal` and `settle_deal`; the voucher of the freeze epoch still registers (`freeze.rs:73`, see C-2).
- An empty list of official contracts is the old behaviour (see C-5).

Scenarios were written from the code and have not been run; C-6 and C-7 are the first to turn into unit tests in `deal.rs` / `commit.rs`.
