# Security findings tracker (BE-062)

One table for every finding of the cross reviews: batch 2 (`security-review-batch2.md`, SDK of P5 to P2), batch 3 (`security-review-batch3.md`, frontend and agents) and the contract 0.0.12 (`security-review-0.0.12.md`). Status: `open`, `fixed <commit>`, `by design`, `info`. A fix is entered when it is seen in `git log` of the repository named; "in progress" means a change is in the working tree and not committed. Last update: after `sdk 3d0d269`, `frontend 300c2af`, `agents 694d38d`, `contracts f4c0d22`, `backend 7ece83d`. Lockfile of the SDK (`3d0d269`) is not a finding.

Levels: **High** (a proof or money can be forged by the other party), **Medium** (a guarantee fails under an easy mistake or a plausible setup), **Low** (hardening), **Info** (a limit to write down).

## Batch 2: SDK, P5 to P2
| ID | Level | Repo | Summary | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| B2-F1 | High | sdk | A 65-byte body has the `cipher_hash` of any ciphertext above 4 MiB: false proof of cheating against an honest seller (`license.ts`) | fixed `cbfb657` (backend follows: `83636e6`) | Main B |
| B2-F2 | Medium | sdk | Same cause: `content_hash` of a large file equals the hash of a 65-byte file | fixed `cbfb657` | Main B |
| B2-F3 | Medium | sdk | `BuyerMeter` ceiling counts all receipts, not the epoch | fixed `53f3fea` | Main B |
| B2-F4 | Medium | sdk | `payForProofs` pays twice when `alreadyPaid` / `alreadySpent` are not given again | fixed `82e12f6` (both required; backend test follows `83636e6`) | Main B |
| B2-F5 | Medium | sdk | `milestoneVoucher` has no memory: a milestone can be paid again, past the budget | fixed `82e12f6` (`OrderLedger`, `paid` required) | Main B |
| B2-F6 | Low | backend | `endpointProblem` accepts `localhost.`, `*.internal.`, `127.0.0.1.nip.io`; the SSRF guard keeps the trailing dot | fixed `eb1ffc9` | Main C |
| B2-F6s | Low | sdk | Same defect in the copy of `endpointProblem` in `metered-presets.ts` | fixed `c033f39` | Main B |
| B2-F7 | Low | sdk | `SellerJob.accept` does not check `resource` (`job:<id>`) | fixed `36b99f8` | Main B |
| B2-F8 | Low | sdk | `BigInt()` of the price in the 402 takes hex, spaces and empty text | fixed `75b0f89` | Main B |
| B2-F9 | Low | sdk | `catchUpVoucher` signs on top of any `state`; the caller must read it from the chain | fixed `d303b65` (a warning and `catchUpVoucherFromChain` that reads the state itself) | Main B |
| B2-F10 | Low | sdk | `httpsSource` follows redirects, checks only the last address, no host check on the buyer side | fixed `4af7b7d` | Main B |
| B2-F11 | Info | sdk | XChaCha20-Poly1305 does not commit to its key | fixed `5bb48e3` (`key_commitment`, `key_mismatch`) | Main B |
| B2-F12 | Info | sdk | The release has no purchase id; `payForProofs` trusts the proof list of the backend | fixed `5bb48e3` (`purchase_id`) and `82e12f6` (`verifyTx` optional) | Main B |

## Batch 3: frontend and agents
| ID | Level | Repo | Summary | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| B3-F1 | High | frontend | `BuyForm` signs a voucher to the payee and price of the API; the signature of the listing is never checked (`Licenses.tsx`) | fixed `93679f3`; re-checked: a hash that is not the one typed, and a right hash with a signature that is not the key of the seller in the contract, give no purchase | Main B |
| B3-F2 | High | frontend | The seller seals the file key to the public key the API names as the buyer | fixed `93679f3`; the key is read from the contract and its fingerprint is shown; residual: the buyer account still comes from the API (the seller matches the fingerprint by another channel) | Main B |
| B3-F3 | Medium | frontend | Notices name the order, purchase or invoice by what the API says; no recomputed hash, no match with the id the user typed | fixed `fbe0733` (orders), `ae9c3de` (purchases), `d2ba07c` (invoices) | Main B |
| B3-F4 | Medium | frontend | CSP has no `script-src` and no `connect-src` | fixed `3b5ee77`, `4ad4b2b`; limit: the CSP is not tried with a real wallet yet (UM-092 of the owner) | Main B |
| B3-F5 | Low | frontend | The voucher key stays in the state of the page until the tab closes | fixed `3e64818` | Main B |
| B3-F6 | Low | frontend | The browser fetches the address the seller wrote, following redirects | fixed `c87b465` (the host is shown before the download) | Main B |
| B3-F7 | Low | frontend | `checkAccessBeforeNextDay` trusts `paidUntil` from the broker itself | fixed `300c2af`; limit: a change of text only, there is no direct check with the provider | Main B |
| B3-F8 | Low | agents | `loadIdentity` reads the key file without checking mode or owner | fixed `694d38d` | Main B |
| B3-F9 | Info | frontend | The file key of the seller lives only in the page (lost on refresh) | fixed `c87b465`; limit: a warning only (the key is still lost with the page) | Main B |

## Contract 0.0.12 (CT-094, CT-095, CT-096; `security-review-0.0.12.md`)
| ID | Level | Repo | Summary | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| C-1 | Medium | contracts | `complete_escrow` does not ask `is_official`: a token already escrowed when the list is set stays for sale | fixed (`46c2e62`) | A2 |
| C-2 | Low | contracts | `apply_freeze` records `current_epoch`, the new epoch after `close_epoch`: the freeze bites one epoch late when applied during clearing | by design | A2 |
| C-3 | Low | contracts | The freeze record is not removed when the member exits | by design | A2 |
| C-4 | Info | contracts | A pending freeze blocks nothing and is not seen by `register_with` | info | A2 |
| C-5 | Info | contracts | An empty list of official contracts means any contract; clearing it has no timelock | info | A2 |
| C-6 | Medium | contracts | `charge_fees` (`commit.rs:71`) cuts the limit to `stake`, not `stake - bond_locked`: the invariant of the bond breaks after a fee charge | fixed (`e0ac161`) | A2 |
| C-7 | Medium | contracts | A default takes `due.min(stake)` from the whole stake, bonds included; then `slash_bond` panics (`checked_sub(...).expect`) and `rule_deal` cannot run: a guilty verdict can be dodged by defaulting | fixed (`7d9d689`) | A2 |
| C-8 | Medium | contracts | `dispute_deal` does not require the complainant's own bond to be locked: after the other party confirmed, a false complaint costs nothing | fixed (`7d9d689`) | A2 |
| C-9 | Low | contracts, sdk, backend | `rule_deal` changes limits with no `limits_updated`; the events of CT-094 are not in the SDK and the indexer, so stake and limit in the read model stay old after `bond_slashed` | fixed (`7d9d689` (event), indexer `593c598`) | A2 (event), Main B (SDK), Main C (indexer) |
| C-10 | Low | contracts | At `now == confirm_by` both `dispute_deal` and `settle_deal` are valid | fixed (`7d9d689`) | A2 |
| C-11 | Info | contracts | The bond is avoided by splitting a swap below the threshold or by a ring of three | info | A2 |
| C-12 | Info | contracts | Nothing ends by itself: `settle_deal` must be called to free a bond and the exit | info | A2 |

## Batch 5 (SD-074 facilitator, SD-072 delegate order)
| ID | Level | Repo | Summary | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| B5-F1 | Medium | sdk | `payForProofs` of a delegate order: `alreadyPaid` must hold the keys (`proposal:<id>`), not the `paid` hashes, or a proposal is paid twice | open | Main B |
| B5-F2 | Medium | sdk | Facilitator against a contract older than 0.0.12: `is_frozen` view missing, every verify is `500 internal_error` | open | Main B |
| B5-F3 | Low | sdk | `verifyTx` is synchronous and cannot ask the chain | open | Main B |
| B5-F4 | Low | backend | `mandate.dao` must answer the Sputnik view `get_policy` (`order_bad_mandate` / `not_a_dao`; 503 without RPC); registry not required, the buyer signs the mandate | fixed (see commit below) | Main C |
| B5-F5 | Low | sdk | Order of the refusals in `docs/order.md` differs from the code | open | Main B |
| B5-F6 | Info | sdk | 10 s window of `is_frozen`, stricter rule in the epoch of the freeze | info | Main B |
| B5-F7 | Info | sdk | The mandate does not bind the direction of the vote | info | Main B |
| B5-F8 | Info | backend | `before_order` uses the first-post time of the order | info | Main C |

## Batch 4 (cross review of the backend by Main B: claims of a delegate order, proof of the grantee)
| ID | Level | Repo | Summary | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| B4-F1 | Medium | backend/broker | Pending GitHub invitation not cancelled after a restart of the broker (the id was in memory only) | fixed `23f66d1` (id in the handle; list lookup for old handles) | Main C |
| B4-F2 | Medium | backend/broker | GitHub handle shared by two grants; a collaborator or org member from before the grant was removed at the end of the rent | fixed `23f66d1` (grant id and `preexisting` flag in the handle; the manager refuses a second live grant for the same login and resource) | Main C |
| B4-F3 | Low | backend | A `tx.status` string counted as success | fixed `33ddaf2` | Main C |
| B4-F4 | Low | backend | Two claims at the same time: 500 for the second | fixed `33ddaf2` (400 `already_claimed`) | Main C |
| B4-F5 | Low | backend/broker | An SSH key type that cannot be proven was accepted as a reference | fixed `71fd270`; the page of the grantor is Main B | Main C, Main B |
| B4-F6 | Low | backend/broker | The challenge was used up before the proof was checked; the gist was read without a token | fixed `71fd270`: used up only by a verdict, one proof at a time per grant, token on the gist request | Main C |
| B4-F7 | Low | backend/broker | `proof: null` for adapters with no proof, warning only in the POST answer | fixed `71fd270`: `not_applicable`, `grantee_unproven` also on GET access; the page of the renter is Main B | Main C, Main B |
| B4-F8 | Info | backend/broker | The voucher key for the gist signature comes from the read API, not the contract | info (one operator for the broker and the read API) | Main C |
| B4-F9 | Info | backend | One on-chain vote pays one order of the circle; the status of the proposal is not read | info | Main C |
| B4-F10 | Info | backend/broker | Two first requests at the same time on a provider with no challenge both call `grant` | info | Main C |

## Batch 6 (one-time codes: SD-076, FE-032, AG-030)
| ID | Level | Repo | Summary | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| B6-F1 | High | backend, frontend | A dispute `other` without proof ends `disputed` (unpaid) for a buyer who holds a working code; a code works once | open (needs a decision) | Main C, Main B, coordinator |
| B6-F2 | Medium | sdk, backend, frontend | `arbiter` is a name, not a bond: it lifts the 20 credit cap and the pages say "dengan jaminan" | open (needs a decision) | Main C, Main B |
| B6-F3 | Medium | agents | The buyer agent confirms at once, without trying the code and giving up the one hour window | open | Main B |
| B6-F4 | Low | sdk, frontend, agents | The delivery is not checked against the code document of the listing (`doc` not passed) | open | Main B |
| B6-F5 | Low | sdk, backend | No bound on the size and characters of a code on the receiving side | backend fixed (`BE-069: fix`); SDK open | Main C fixed, Main B |
| B6-F6 | Low | frontend | The public key of the seller is typed, not read from the contract | open | Main B |
| B6-F7 | Low | frontend | The label says the code is sent nowhere; plain text field | open | Main B |
| B6-F8 | Info | agents | The mock book differs from the real one | info | Main B |
| B6-F9 | Info | agents, backend/broker | Redaction of the key is by exact string only | info | Main B, Main C |
| B6-F10 | Info | frontend, backend | The seller seals the key to the buyer that the backend names | info | Main C |

## Found by the near-sandbox test
| ID | Level | Repo | Summary | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| BE-055-S1 | Medium | backend | `events_raw.data_json` is an array with one object on a real chain, and the queries of the proofs (`epoch`, `solver`), of the installments (`voucher_registered`) and of the intent book (`intent_posted`) read `$.field`: on a real chain the epoch of a proof was null, no solver proof was ever found, the event of an installment was never matched and the on-chain data of an intent was empty. Found only by the run on near-sandbox (the unit tests stored a bare object). Solver (A2) asked to check the same reading | fixed `6a2a6ef`, `7220eeb`, `1caffb0` (`event-data.ts` reads both shapes); confirmed on near-sandbox in run 4 | Main C |

## Counts
Fixed: BE-055-S1, B2-F1 to F12 (F6 in the backend and in the SDK), B3-F1 to F9. Open: B5-F1 to B5-F3, B5-F5. Batch 4: B4-F1 to F7 fixed, B4-F8 to F10 info. Batch 6: B6-F1 to F4, F6, F7 open, B6-F5 backend half fixed, F8 to F10 info. Fixed also: C-1, C-6 to C-10 (contracts 0.0.12, A2). By design: C-2, C-3. Info (documented): C-4, C-5, C-11, C-12. Limits written in the table: B3-F2 (buyer account from the API, confirmed by fingerprint), B3-F4 (CSP not tried with a real wallet), B3-F7 (text only), B3-F9 (warning only).
