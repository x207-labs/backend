# One-time codes and secrets (P3, ADR-48): design for BE-069 and BE-070

Status: **design, to be agreed with the coordinator before code**. The format is SD-076 of Main B. Change of 2026-11-03 (coordinator): the listing holds `code_commitment = sha256(salt ‖ code)` with a random salt, not the plain hash of the code, because a plain hash on a public listing can be tried against codes of low entropy and the code stolen. So **`code_hash` is no longer unique per circle** (the same hash would not mean the same code). The SDK checked out here still has the first form (`code_hash`, `code.ts`); the names below follow the new one and the errors of SD-076 are taken as they are (`code_over_limit_unbonded`, `code_bad_commitment`, `code_bad_code`, …).

## BE-069, the code book

### What is reused
A code is sold like a file of BE-056 (ADR-46): the seller encrypts the code, posts the ciphertext and its `cipher_hash`, releases the sealed key to the buyer, and the voucher of the buyer is held until the content matches the commitment; a wrong content is shown with the cheat proof that anybody can check. For a code the payload is `{salt, code}` and the cheat proof checks `sha256(salt ‖ code) == code_commitment` (function of the SDK). So the purchase table, the held voucher, the release notice, the cheat proof and the takedown are the same code. **There is no exclusive rule by hash any more**: nothing in the listing tells that two listings hold the same code.

### What is new
1. **The listing**: `detail` is JSON with `kind: "code"`, `code_doc` (hash of the code document, like `license_doc`), `code_commitment`, `issuer` (name of an issuer adapter, or `none`), `face_value` (credit, optional), `format` (SD-076). The code document holds `{circle, seller, code_commitment, issuer, value, verifiable, arbiter, nonce}` (SD-076) and is hashed and signed like the license document. A check `codeCheck` runs when the listing is posted (as `licenseCheck`).
2. **The code book** `code_book(id, circle_id, listing_hash UNIQUE, code_commitment, seller, issuer, verifiable, status, verdict, checked_at_ms, created_at_ms)` stores the `code_commitment` as it is, **with no unique constraint**. Status: `listed`, `held` (a purchase is open), `sold`, `used` (the issuer says it was used), `void` (taken down or cancelled). A cancelled purchase puts the row back to `listed`.
   **The same code sold twice is stopped by other means**, in this order: the check at the issuer before the key is released (`code_used`), the cap of 20 credit for a code that cannot be checked (and the bond above it), the one-hour window with the held voucher, and the reputation of BE-053 (a seller whose purchase is refuted loses it). The backend can still see one thing: after a sale it knows the plain code (it was shown for the check) and can refuse the check of a second listing whose `sha256(salt ‖ code)` differs but whose code equals a **sold** code of the circle: it keeps `sha256(code)` of the codes it has checked (`code_seen`), only for checkable issuers and only as a hash with a secret pepper of the backend, so the table cannot be used to try codes. This is an extra, not a promise (a seller can change a character the issuer ignores); open for agreement.
3. **The dispute window is one hour** (`dispute_until = released_at + 3600`), set per kind of purchase; the license window of BE-056 stays as it is.
4. **The cap**: a code that the issuer adapter cannot check (`issuer: "none"`, or an adapter with `checkable: false`) is limited to **20 credit** (`CODE_UNCHECKED_CAP`, env `X207_CODE_UNCHECKED_CAP`); above it the listing needs the bond of CT-094 (the same `bond_threshold` flow that ADR-46 uses for an exclusive license; the listing carries `bond: true` and the purchase is refused `bond_required` when the pair has no deal). Value above the cap without the bond: `code_value_over_cap` (400).
5. **The issuer adapter** (backend, `src/marketplace/code-issuers.ts`):
   ```ts
   interface CodeIssuerAdapter { readonly name: string; readonly checkable: boolean; checkCode(code: string): Promise<"valid" | "used" | "unknown"> }
   ```
   `MockCodeIssuer` holds a set of codes: `issue(code)`, `markUsed(code)`, `checkCode` answers from it. Real issuers are written by the operator and registered at start (`marketplaceRoutes(db, { codeIssuers })`).
6. **The check before the key is released.** The backend never sees the plain code, so the check needs the seller to show it once:
   `POST /x207/circles/{circle}/codes/{code_commitment}/check` body `{notice, signature, code, salt}`. The notice (`circle, code_commitment, actor, action: "check", at`) is signed by the seller. The backend checks `sha256(salt ‖ code) == code_commitment` (function of the SDK), calls `checkCode(code)`, stores only the **verdict** and the time, and answers `{verdict, checkedAt}`. The code is not stored, not logged, and not kept in an error (the access log of the route must not print the body; the audit of BE-066 does not). A verdict `valid` is good for 10 minutes (`X207_CODE_CHECK_TTL_SECONDS`).
   The release of the key (`POST purchases/{id}` action `key_released`) for a listing with a checkable issuer is refused unless the book has a fresh verdict `valid`: `code_not_checked` (409) when there is none or it is old, `code_used` (409) when the verdict is `used` (the purchase is cancelled and the voucher released to the buyer, nothing moves), `code_unknown` (409) when the issuer does not know the code.
   **Exposure, to agree**: the backend sees the plain code during the check. It could redeem it first. This is the price of a check before the release; the alternative is to check after the release (the buyer decrypts and asks the issuer, and disputes with the code as evidence when it is `used`), which exposes nothing to the backend but leaves the buyer one hour of risk. Both are possible: the check is optional for `checkable: false` and the dispute path always exists.
7. **Personal or identity-bound codes are refused** at the listing (`code_bound_to_identity`, 400) when `FORMAT` says the code is bound (a gift code tied to an account, a ticket with a name). Until SD-076 exists the rule is a flag in the listing, `identity_bound: false`, that the seller must state; true is refused.

### Routes (all under `/x207/circles/{circle}`)
| Route | What |
| --- | --- |
| `POST /listings` | a listing with `detail.kind: "code"` is checked by `codeCheck`; creates the row in `code_book` |
| `POST /codes/{code_commitment}/check` | the seller shows the code once; the answer is the verdict |
| `GET /codes/{code_commitment}` | public state without the code or the salt: `{codeCommitment, status, issuer, checkable, verdict, checkedAt, listingHash, priceCap}` |
| `POST /listings/{hash}/purchases`, `POST /purchases/{id}` | as BE-056, with the rules above; the open-object cap of BE-066 applies |

### Errors proposed
| Code | Status | When |
| --- | --- | --- |
| `code_over_limit_unbonded` (SD-076) | 400 | not checkable, value above 20 credit, no arbiter |
| `code_bound_to_identity` | 400 | the code is personal or bound to an identity |
| `code_bad_commitment` (SD-076) | 400 | the commitment is not 64 lowercase hex, or `sha256(salt ‖ code)` does not match it at the check |
| `code_bad_code`, `code_bad_account`, `code_bad_value`, `code_bad_nonce`, `code_bad_arbiter`, `code_bad_limit` (SD-076) | 400 | the code document is not valid; mapped as they are, 400 |
| `code_not_checked` | 409 | key release without a fresh verdict `valid` for a checkable issuer |
| `code_used` | 409 | the issuer says the code is used; the purchase is cancelled |
| `code_unknown` | 409 | the issuer does not know the code |
| `code_issuer_unknown` | 400 | `issuer` is not registered in this backend |
| `code_issuer_unavailable` | 503 | the issuer could not be asked; nothing is decided, ask again |

### Tests planned
The same commitment can be listed twice (no constraint); a used code refused by the mock issuer before the key is released and the voucher freed; window of one hour (a confirm at 59 minutes, silence confirms at 61); unchecked above 20 credit refused and accepted with the bond; the plain code is in no table, no log line and no error body (a test reads the database and the answers); an old verdict is refused; the BE-056 cheat proof works for a code.

## BE-070, the proxy of secrets (the broker)

### What is reused
The class C proxy: the scope of paths and methods (`inScope`), the quota per epoch, the audit, the redaction of the secret in the answer, `redirect: manual`, the settlement only after a success of the provider.

### What changes
1. **Real keys only in `self-hosted` mode.** In `hosted` mode a provider whose `secretEnv` names a real secret is refused at start (`ConfigError`), and a call through a provider that is not the mock answers `501 secret_hosted_forbidden`. Providers for `hosted` are marked `mock: true` in `ProviderConfig` (a local server of the demo). The same rule as P2 (`hosted_mode_real_provider`).
2. **The bill per call matches the count of the buyer (SD-068).** The 402 of a call announces the meter (`unit: "call"`, price per call as a decimal whole number above 0, quantity 1); the buyer meter checks `meter_unit_mismatch`, `meter_price_too_high`, `meter_amount_mismatch`. The broker bills one unit per **successful** call (a status of 400 or more, a redirect, and an unreachable provider are not billed and give the quota slot back, as now), and writes the count of billed calls per grant and epoch so that `GET /grants/{id}/usage` (new, read-only, same body as the meter the buyer keeps) can be compared by the buyer. A call whose answer is cut by the timeout is not billed.
3. **#61 (API credit of an AI provider)** only through the official sub-key feature of the provider: the provider adapter creates a sub-key with a limit at the provider (`createSubKey`, `revokeSubKey`, like the P2 adapters), and the proxy never forwards the master key. A plain shared key is refused at the grant (`scope_invalid`, status X in the catalogue). Waiting for the confirmation of the owner (ADR-48 point 4); not built before it.

### Errors proposed
`secret_hosted_forbidden` (501, hosted mode with a real secret), `secret_not_configured` (502, the environment variable of the secret is empty; today `delivery_failed`), `subkey_unsupported` (400, #61 grant for a provider with no sub-key feature).

### Tests planned
Hosted refuses a real provider at start and at call; the bill of a series of calls (successes, a 500, a timeout, a redirect) equals the count the buyer meter computes; the secret appears in no answer, no audit line, no error.

## Open questions for the coordinator
1. The check before the release shows the plain code and its salt to the backend (item 6). Agree, or check after the release only? And the optional `code_seen` table of peppered hashes (item 2): yes or no?
2. `bond` for a code above 20 credit: the bond of CT-094 is for a deal with an arbiter named in signed terms. For a sale of a code, is "the listing carries `bond: true` and the pair has a deal with an arbiter" the intended meaning, as for the exclusive license of ADR-46?
3. The names of the errors above.
