# Security findings tracker (BE-062)

One table for every finding of the cross reviews: batch 2 (`security-review-batch2.md`, SDK of P5 to P2), batch 3 (`security-review-batch3.md`, frontend and agents) and the contract 0.0.12 (`security-review-0.0.12.md`). Status: `open`, `fixed <commit>`, `by design`, `info`. A fix is entered when it is seen in `git log` of the repository named; "in progress" means a change is in the working tree and not committed. Last update: after `sdk 82e12f6`, `frontend b388efb`, `agents 6de5f2f`, `contracts f4c0d22`, `backend 83636e6`.

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
| B2-F6s | Low | sdk | Same defect in the copy of `endpointProblem` in `metered-presets.ts` | open (change in the working tree, not committed) | Main B |
| B2-F7 | Low | sdk | `SellerJob.accept` does not check `resource` (`job:<id>`) | open | Main B |
| B2-F8 | Low | sdk | `BigInt()` of the price in the 402 takes hex, spaces and empty text | open | Main B |
| B2-F9 | Low | sdk | `catchUpVoucher` signs on top of any `state`; the caller must read it from the chain | open | Main B |
| B2-F10 | Low | sdk | `httpsSource` follows redirects, checks only the last address, no host check on the buyer side | open | Main B |
| B2-F11 | Info | sdk | XChaCha20-Poly1305 does not commit to its key | fixed `5bb48e3` (`key_commitment`, `key_mismatch`) | Main B |
| B2-F12 | Info | sdk | The release has no purchase id; `payForProofs` trusts the proof list of the backend | fixed `5bb48e3` (`purchase_id`) and `82e12f6` (`verifyTx` optional) | Main B |

## Batch 3: frontend and agents
| ID | Level | Repo | Summary | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| B3-F1 | High | frontend | `BuyForm` signs a voucher to the payee and price of the API; the signature of the listing is never checked (`Licenses.tsx`) | open | Main B |
| B3-F2 | High | frontend | The seller seals the file key to the public key the API names as the buyer | open | Main B |
| B3-F3 | Medium | frontend | Notices name the order, purchase or invoice by what the API says; no recomputed hash, no match with the id the user typed | open | Main B |
| B3-F4 | Medium | frontend | CSP has no `script-src` and no `connect-src` | open | Main B |
| B3-F5 | Low | frontend | The voucher key stays in the state of the page until the tab closes | open | Main B |
| B3-F6 | Low | frontend | The browser fetches the address the seller wrote, following redirects | open | Main B |
| B3-F7 | Low | frontend | `checkAccessBeforeNextDay` trusts `paidUntil` from the broker itself | open | Main B |
| B3-F8 | Low | agents | `loadIdentity` reads the key file without checking mode or owner | open | Main B |
| B3-F9 | Info | frontend | The file key of the seller lives only in the page (lost on refresh) | info | Main B |

## Contract 0.0.12 (part 1: CT-095, CT-096)
| ID | Level | Repo | Summary | Status | Owner |
| --- | --- | --- | --- | --- | --- |
| C-1 | Medium | contracts | `complete_escrow` does not ask `is_official`: a token already escrowed when the list is set stays for sale | open | A2 |
| C-2 | Low | contracts | `apply_freeze` records `current_epoch`, the new epoch after `close_epoch`: the freeze bites one epoch late when applied during clearing | by design | A2 |
| C-3 | Low | contracts | The freeze record is not removed when the member exits | by design | A2 |
| C-4 | Info | contracts | A pending freeze blocks nothing and is not seen by `register_with` | info | A2 |
| C-5 | Info | contracts | An empty list of official contracts means any contract; clearing it has no timelock | info | A2 |
| C-094 | - | contracts | CT-094 (bonds, deals, arbiter): not reviewed yet, the code is not committed (list of checks in the report) | pending | Main C |

## Counts
Fixed: B2-F1 to F5, F6 (backend), F11, F12. Open: B2-F6s, F7 to F10; B3-F1 to F8; C-1. By design: C-2, C-3. Info: B3-F9, C-4, C-5. Pending: C-094.
