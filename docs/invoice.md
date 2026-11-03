# Invoice book and installments (BE-051, ADR-44)

Routes of spec 5e. The document and the vouchers are those of `@x207/core` (`sdk/docs/invoice.md`, SD-065); the codes of `InvoiceError` are passed on unchanged (`400`, `404 installment_not_found`, `409 installment_already_shifted` and `409 installment_bad_state`).

## Flow
1. `POST invoices` `{document, installments, notice, signature}`: the issuer (active member) signs a notice `requested`; the debtor must be a member. The first installment falls in the **open epoch + 1**, the others follow one epoch each. `invoice_hash` is unique per circle (`409 invoice_duplicate`). `needsBond` is true when the amount is at or above the bond threshold (`bondThreshold` of `marketplaceRoutes`, default `100000000` = the default of the contract; CT-094 itself is on the contract).
2. `POST …/approve` `{vouchers: [{voucher, signature}]}`: one voucher per installment, exactly `installmentVoucher(plan, i)` (seq 1 of the pair in its epoch), signed by the debtor. Anything else is `409 installment_voucher_mismatch`, a signature that is not the key of the debtor is `401 invalid_signature`.
3. `POST …/reject` `{notice, signature}`: the debtor, from `requested` only.
4. `POST …/installments/{index}/catch-up` `{voucher, signature}`: only for an installment that failed for lack of headroom and was not shifted yet. The voucher must be `catchUpVoucher(plan, index, state)` where `state` is the pair `(debtor, issuer)` in the next epoch as the indexer sees it now; a stale voucher is a mismatch and the debtor signs again.

## What the backend decides, and from what
The backend registers nothing. It reads the events `voucher_registered` that the indexer stored (`events_raw`) and the obligations:

| Observation | Installment |
| --- | --- |
| an event with the `(payer, payee, epoch, seq)` and the cumulative amount of the voucher we wait for | `registered` |
| the epoch of the voucher is over and the pair has `seq` at or above ours, but not our voucher | `missed`, `blocked_by_debtor` (the debtor registered a higher `seq` first: `ERR_SEQ_NOT_INCREASING` for the issuer) |
| the epoch is over and the pair never reached our `seq` | stays `scheduled` with `reason: headroom`: the debtor may shift it once |
| the shifted installment fails again, or the epoch it would shift to is over too | `missed`, `headroom` |

Invoice: `registered` when every installment is, `missed` as soon as one is, `expired` when nobody approved before the epoch of the first installment closed. The status is recomputed on every read of the book and of the reputation; there is no clock.

A shift keeps `epoch` of the installment (the plan of the SDK is computed from it) and sets `voucherEpoch` to the epoch of the catch-up voucher.

## Reputation (BE-053)
`reputationOf(debtor)` adds `invoices: {registered, missed, blockedByDebtor, missedIssuers}`. An invoice with every installment registered counts as a completed deal with its issuer; a `missed` invoice (any reason) counts as a failure, once per issuer. The formula in the answer has `missedInvoices` in the denominator of the rate.

## Limits
- `voucher_registered` is the only evidence; a voucher registered under another `resource` with the same `(epoch, seq)` and amount would look the same. The contract does not link a voucher to an invoice.
- Whether an issuer tried to register at all cannot be seen: no registration before the close of the epoch is read as "failed for headroom".
- The bond (CT-094) is not checked here, only flagged.

Notice format: canonical JSON, keys `circle, invoice_hash, actor, action, at, reason`; `action` is `requested` or `rejected`; `reason` is `null` except for an optional text with `rejected`; signed with `nep413SigningHash(json, sha256(json), circle)` and the voucher key of the actor (same scheme as `delivery-core.ts`, code in `notice.ts`).

## Voucher for the issuer
Each installment in `GET invoices/{hash}` has `voucher` (the unsigned voucher of the plan) and `signature`, once the invoice is approved (`null` before). After a shift they are the catch-up voucher. The issuer registers it with the contract; anybody may, because it pays the issuer only what the debtor approved.
