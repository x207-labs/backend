# Minimal reputation in the read API (BE-053)

Option 2 and 3 of `docs/reputation-and-disputes.md` (UM-071): a public score that is computed from facts that cost money, never from ratings. It says "pays and finishes deals", not "delivers well".

## What is counted
A **performance** is one handover of a match: the seller delivers the offered asset to the counterparty; in a `barter` match the counterparty also delivers the wanted asset (`side` `want`, BE-047). For each performance the deliverer gets:

| Outcome | When | Counted |
| --- | --- | --- |
| `completed` | the handover is confirmed (or needs no confirmation: class A, class D) **and the receiver registered the payment for it** | positive |
| `disputes` | the receiver disputed it (`delivery.state` `disputed`) **and the receiver has itself paid somebody for something** | negative |
| `abandoned` | the deliverer withdrew, or the receiver cancelled because nothing came by `deliver_by` | negative |

A performance still waiting (`awaiting`, `delivered`) counts for nothing yet. **Paid** means: in the read model of D9 the receiver has an obligation to the deliverer, in the epoch of the match or later, of at least `listing_value - discount_value` (a payment), or of at least the leg `receiver -> deliverer` of the signed bundle (`max_amount`). Without the payment nothing is positive, so two accounts cannot make a record out of deals that cost nothing.

**One count per counterparty.** `completed`, `disputes` and `abandoned` each count *distinct counterparties*; the number of transactions is shown next to it. Five deals with the same buyer count as one, so a pair of accounts that trade with each other in a loop cannot raise anything beyond one counterparty. (Wash trading is also limited by ADR-08: it does not raise credit limits.)

**A dispute counts only from an account that has paid before.** A new account has nothing to lose by complaining; its dispute is shown nowhere and weighs nothing. This is a cheap guard, not a proof: a patient attacker can make an account that pays once.

## The score
`score = round(1000 × completed / (completed + disputes + abandoned) × completed / (completed + 5) × (checksPassed + 1) / (checksPassed + 3 × checksFailed + 1))`, with every count a number of distinct counterparties; `0` when nothing is completed. The second factor is the confidence: a seller with one counterparty cannot reach more than 167; with ten, 667 at most. The third is the random checks (SV-018). The answer carries the formula as text.

Also in the answer: `completionRate`, `responseSeconds` (median of the time from the match to the delivery, over completed and confirmed deliveries with a delivery row, and the number of samples), `spotChecks` (`passed`, `failed`, `verifiers`).

## Routes
- `GET /x207/circles/{circle}/reputation/{account}` → the record of one member (`404 member_not_found` for a stranger; a member with no history has `score: 0`, `completionRate: null`).
- `GET /x207/circles/{circle}/reputation?limit=` → the accounts that appear in matches, best score first.
- `POST /x207/circles/{circle}/reputation/spot-checks` with `{notice, signature}`: the result of a random check of a job (SV-018). The notice is `{circle, subject, verifier, job_hash, passed, expected_hash, got_hash, at}` (canonical JSON in this key order, NEP-413 style, signed with the voucher key of the verifier). The verifier must be an **active member** and not the subject; `at` within 600 s of the server clock; one result per `(subject, job_hash)` (`409 already_exists`). `passed` must agree with the two hashes when they are given.

## What it does not do
- It does not say that goods were good: a seller of poor goods that gets paid has a good record. Disputes lower it only when a receiver disputed.
- The payment test is an approximation: an obligation of the same pair in a later epoch for another deal can make a deal look paid. A deal of a pair that trades often is therefore counted once anyway.
- It is not read by the contract. The limit of a member does not depend on it.
- There is no weight for the verifiers of random checks: a verifier is an active member, which costs a stake, nothing more.
