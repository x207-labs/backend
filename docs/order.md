# Service order book (BE-054, ADR-45)

Routes of spec 5f (without `onchain-proofs`, BE-055). Document, hash and rules: `@x207/core` (`sdk/docs/order.md`, SD-069). The codes of `OrderError` are passed on, except that `order_sample_required` and `order_target_required` are answered as `sample_required` and `target_required` (the names of the spec).

## Creating
`POST orders` `{order, signatures: [{account, signature}]}`. A signature is over `serializeOrder(order)` with the NEP-413 style hash and the voucher key of the party (same scheme as the other notices, `notice.ts`). One signature stores the order as `proposed`; the second (the same POST again, with the other party's signature) opens it (`200`). `409 order_duplicate` when nothing new. `needsBond` when the budget is at or above `bondThreshold` (default 100000000). Nothing moves until the order is `open`.

## Three patterns
- **milestone** (`research`, `prompt`, …): notice `delivered` (seller, with `deliverable_hash`), then `confirmed` or `disputed` (buyer, inside the window). **Silence for the whole window confirms** (`disputeWindowSeconds`, default 72 hours, same rule as BE-047). `cancelled`: the seller before the buyer confirms, the buyer only on a milestone still `open` after `due_at`.
- **outcome** (`lead`, `bug`): `POST …/outcomes` with `proposed` (seller, `deliverable_hash` = hash of the result; the same hash cannot fill two places), then `accepted` (milestone `confirmed`, `outcome: accepted`) or `rejected` (milestone `disputed`, `outcome: rejected`). **No automatic confirmation:** a silent buyer pays nothing (ADR-45 point 4).
- **proof** (`keeper`, `solver`): no milestone action; see BE-055.

Milestone notice: canonical JSON, keys `circle, order_hash, milestone, actor, action, at, deliverable_hash, reason` (the format of FE-027). `reason` is required for `disputed` (`not_received`, `not_as_described`, `other`), optional text for `rejected`.

A confirmed milestone becomes `paid` when the obligations of the pair (buyer, seller) in the epochs since the order was made cover the sum of everything confirmed so far. The backend pays nothing; the buyer registers the voucher (SDK `milestoneVoucher`). Limit: another order of the same pair adds to the same obligations.

## Load test target (`target-check`)
A `loadtest` order cannot be delivered (`409 target_unverified`) until `POST …/target-check` finds the proof: the file `https://<target>/.well-known/x207-loadtest` with the order hash as body, or a DNS TXT record on the target equal to `x207-loadtest=<order_hash>` (also when split in several strings). The answer is `{order_hash, target, target_verified, checked_via}`.

The fetch is behind the guard of `ssrf.ts`, because the backend would otherwise fetch any URL a user names:
- `https` only, port 443 only, no credentials in the URL, no IP literal that is not public;
- the name is resolved and **every** address must be public (loopback, private, link-local including `169.254.169.254`, CGNAT, multicast, documentation, Teredo/6to4, IPv4-mapped and NAT64 forms of those are refused);
- the address is checked **again when the socket connects** (the `lookup` hook of the connection), so a name that answers public once and private later does not get through;
- no redirect (3xx), at most 4 KB, 5 seconds;
- any of these is `403 target_forbidden`. A host that is down or has no file is not a violation: `target_verified: false`.
The TXT lookup is DNS only and runs after the file check, so a target that resolves to a private address is refused before its record is believed.

BE-056 reuses `guardedGet` with `code: "source_forbidden"`.

## Not done here
- The bond of CT-094 is only flagged (`needsBond`). The arbiter for large orders is not built.
- Reputation (BE-053) does not read orders yet.
