# Second security review: facilitator, chainCache, broker (interface 0.0.8)

Read as an attacker. This lists what was tested, what was found and what was not checked; it is not a statement that the code is safe. "Test" means a test in the repository. A test marked `it.fails` asserts the safe behaviour and passes only while the bug exists: when the SDK is fixed it turns red and `.fails` is removed. The SDK belongs to sdk and frontend team and was not changed.

Tests: `tests/security-review-facilitator.test.ts` (umbrella, facilitator and `chainCache`) and `backend/broker/test/security-review.test.ts` (broker).

## Open in the SDK (reported to the project lead, not changed)
| # | Finding | Test | Worst case |
| --- | --- | --- | --- |
| R1 | **High.** Replay in parallel. `/verify` reserves nothing and `/settle` answers success again to the payload that is already stored (idempotence by commitment id). The middleware calls `/verify`, the handler, then `/settle`, so n parallel requests with one voucher all pass `/verify`, run the seller's handler n times, and all settle OK. The payer pays one price and gets n resources. | `TC-SR2-04` (`it.fails`) | (n-1) x price for each voucher the payer signs; n is limited only by the concurrency of the seller. Repeats with each new voucher. |
| C1 | `chainCache`: a payer suspended or defaulted inside the window still passes `/verify`. `member` is kept 15 s and `headroom` 10 s, and the status in `member` is checked by `verify`. The registration is refused on chain (`ERR_PAYER_NOT_ACTIVE`) and the row is dropped. | `TC-SR2-06` (`it.fails`); `TC-SR2-05` shows the same case is refused at once without the cache | Per payer and event: at most the headroom that was cached (`<=` the limit of the member), because every accepted voucher lowers the headroom that `verify` computes. About 10 s from the last read of `headroom`; after that the real `0` is read (`TC-SR2-08`). Not repeatable by the same payer: once the window ends the payer is refused. |
| C2 | `chainCache`: with no pending row for the pair, the base of the voucher is the cached `obligation`. A registration by another relayer is not seen for 10 s, so vouchers the chain already counts pass `/verify` and are served once each. Own registrations are not affected: they drop the cache (`invalidatePayer`) and the pending row is the base. | `TC-SR2-09` (`it.fails`) | At most the cumulative that the other relayer registered for that pair, times 1: each old voucher once, inside 10 s. The registration of those vouchers fails on chain (seq not above). |

Proposed fix for R1 (sdk and frontend team): the seller keeps the commitment id (`payer:payee:epoch:seq`) of every request in flight and refuses a second one; or `/verify` records a short reservation of `(payer, payee, epoch, seq)` in the pending store. The broker already does the first (below). For C1 and C2: skip the cache for `member` and `headroom` of a payer that has a rejected or failed registration, or lower the TTLs to what a loss of one headroom per event accepts; the numbers above are the loss to weigh.

## Fixed in the broker (the test failed first)
| # | Finding | Test | Fix |
| --- | --- | --- | --- |
| B1 | `POST /grants/{id}/proxy/*`: the scope check refused a literal `..` segment only. `/v1/echo/..%2fadmin` (also `%2e%2e%2f`, `..%5c`) stayed under the prefix and was forwarded as typed; a provider that decodes `%2f` walks out of the scope. | `TC-SR2-B01` | `plainPath`: no encoded slash or backslash, no NUL, no dot segment after decoding; else `403 grant_scope_denied`. |
| B2 | The lessee's headers went to the provider except a short list. `X-HTTP-Method-Override`, `X-Method-Override`, `X-HTTP-Method`, `X-Original-URL`, `X-Rewrite-URL`, `Proxy-Authorization`, `Forwarded`, `X-Forwarded-*`, `Via`, `X-Real-IP` could change the method or route after the scope was checked. | `TC-SR2-B03` | added to the list that is stripped. |
| B3 | A provider that echoes the request headers (some do on errors) gave the secret of the grantor to the lessee in the body. | `TC-SR2-B04` | `ProviderRegistry.redact` replaces the secret in the body with `[redacted]`. |
| B4 | The call followed redirects. A custom secret header (not `authorization`) is not removed by the platform on a cross-origin redirect. | `TC-SR2-B05` | `redirect: "manual"`; a 3xx is passed on without body and does not settle or use quota. |
| B5 | Quota under parallel requests. The quota was read before payment and counted after the call, so six parallel paid calls on a quota of 2 all reached the provider and all settled. | `TC-SR2-B06`, `TC-SR2-B07` | `BrokerStore.reserveCall` takes a slot in one SQL statement before the call; `releaseCall` gives it back when the call fails (status 400 or more, a redirect, or no answer). |
| B6 | `GET /grants/{id}/lease`: two parallel payments both saw `keyAdded=false` and both sent `AddKey`. | `TC-SR2-B08` | payments of one grant run one after the other (`ClassBAdapter.deliver`). |
| B7 | The broker inherits R1: two parallel requests with one voucher paid one lease day twice, six parallel proxy calls with one voucher were all served. | `TC-SR2-B09`, `TC-SR2-B10` | `guardVoucher` keeps the commitment id in flight and answers `409 voucher_in_flight` to a second request. In-memory; after `/settle` the facilitator refuses the voucher itself. |

## Tested and held
- Replay after `/settle`: the same voucher is refused `seq_not_increasing` (`TC-SR2-01`); after a restart of the facilitator the pending store (a file) keeps the seq (`TC-SR2-02`); with an empty pending store the base falls back to the chain, so a voucher the chain counts is refused (`TC-SR2-03`).
- With the cache on, the headroom spent inside the window is bounded by the cached headroom (`TC-SR2-07`: cached 5 prices, 10 vouchers sent, 5 accepted).
- The clock check closes the epoch from `cutoff_at - 120 s` even when `get_epoch` is cached for 30 s (`TC-SR2-10`).
- A path cannot change the host of the call to the provider: the path is appended to the configured `base_url` (`TC-SR2-B02`). `limits.scope` of a class C grant holds only path prefixes and methods, never a URL, so it cannot point the broker at another host.
- A failed provider call gives its quota slot back (`TC-SR2-B07`).

## Read, not tested
- Class B: `limits.scope` is the grantor's. `allowance` is not capped by the broker, so a grantor can ask for a key that burns gas up to the balance of the lease sub-account on the contract it names. A function-call key attaches no deposit, so the loss is gas, not funds. A cap in the config is a product decision.
- Lease: the payer of `/lease` is read from the voucher after `/verify` checked its signature, so it cannot be forged by the header.
- `settlement_pending` is treated as paid by the middleware; the registration is retried by the scheduler (ADR-23).

## Not checked
- Replay across two facilitators that share one pending store file, and the behaviour of the pending store under a real restart during `/settle`.
- The `exact` scheme of `@x402/near` and the gas-key lanes of the relayer.
- Timing: how long the real RPC takes to show a registration, which sets how long C2 lasts in practice.
- Rate limits and body size limits of the broker and of the facilitator.

## Cross review of the SDK (2026-11-03): InFlightGuard, exact NEP-366, gas key lanes, mock Intents fixture
Read as an attacker, no SDK file changed. Tests: `tests/security-review-sdk.test.ts` (umbrella; `it.fails` = open finding, red when the SDK is fixed).

### Open in the SDK (reported to the project lead)
| # | Finding | Test | Worst case and proposed fix |
| --- | --- | --- | --- |
| G1 | **Medium (denial of service).** `x207Middleware` (SD-017) takes the commitment id `payer:payee:epoch:seq` *before* `/verify`. The four parts are public (`/x207/pair-state` gives `lastSeq`), so anybody can send a request with the id of the victim's next voucher and a signature that `/verify` will refuse. While that request waits for `/verify` the real voucher gets `409 voucher_in_flight`. A loop of such requests keeps the id taken almost all the time, so the victim's payments to that seller fail. Cost to the attacker: one request per `/verify` round trip. | `TC-SR3-02` (`it.fails`) | Take the id only when `/verify` answered `isValid`: a forged voucher never takes it, and parallel valid replays are still serialised, because the handler runs only after the id is taken (the others get 409). |
| G2 | The id is given back in `finally` after the handler. A handler that never answers keeps it for the life of the process, also after the client aborted; every such request also keeps a `Set` entry. A voucher is lost for that request only (the payer signs a new `seq`), so this is a leak and a stuck voucher, not a loss of funds. | `TC-SR3-03` (`it.fails`) | Release on `request.signal` abort and after a maximum hold time; give the handler a timeout. |
| L1 | `GasKeyLanes.run` (SD-031) has no timeout on `work` or on `readNonce`. One call that never returns keeps its lane for good; with one lane everything behind it waits for good, with N lanes after N such calls the registration scheduler stops without an error. | `TC-SR3-06`, `TC-SR3-07` (`it.fails`) | A timeout per lane use (then the nonce is read again, as after any failure). |
| F1 | The wasm of `probes/mock_intents` that `deployCircle(params, { mockIntents: true })` (SD-010) deploys is a build artifact in `contracts/target`. It was 94.8 KB and had none of `mt_transfer_call`, `ft_withdraw`, `balance_of`, `mt_resolve`: a test would fail with "method not found" and look like a bug of the circle. I rebuilt it here. | `TC-SR3-09` (passes after the rebuild, fails on a stale wasm) | Build the probe when its source is newer than the wasm, or check the exports in `deployCircle`. |
| F2 | `@x207/core` is imported through `dist/` (`main` in `package.json`). `dist/` of this checkout does not have `buildWithdrawIntentsBalanceCall` (0 matches), so `import { buildWithdrawIntentsBalanceCall } from "@x207/core"` is `undefined` in the umbrella until `npm run build`. | `TC-SR3-08` imports from `src/` to avoid it | Build `dist` in the umbrella test setup, or make the umbrella resolve `@x207/core` to `src`. |

### Tested and held
- One voucher in parallel: 3 requests, one served, two `409`, the handler runs once (`TC-SR3-01`).
- A voucher with `seq` or `epoch` as a string, a float beyond the safe range, or a payer with a space is refused by `validateX207Payload`, so no voucher slips past the guard by having no id (`TC-SR3-04`).
- Two parallel calls never use one lane; after a failed call the lane reads its nonce again (`TC-SR3-05`).
- The builder asks 150 Tgas, the contract wants at least 130 (`INTENTS_WITHDRAW_MIN_GAS`) and needs 80 + 20 for the two promises: a margin of 20 Tgas (`TC-SR3-08`).

### Read, not tested (exact NEP-366, SD-034; the checks are in `@x402/near` 2.28.0, not in this repository)
- The library verifies the signature, `max_block_height` against the current height and `maxTimeoutSeconds`, the nonce against the access key (`final` view), the attached deposit (1 yocto), the gas (`maxSponsoredGas`, default 100 Tgas), the key type (FullAccess only), and keeps a settlement cache by the hash of the signed delegate action, released in `finally` when `submitSignedDelegateAction` returns. A replay after that depends on the access key nonce already being final in the view; I did not test how long that takes on testnet.
- **The relayer pays for transactions that fail.** A payer can pass `/verify` and make the transfer fail before `/settle` submits it (move the USDT away, or send a transaction with the same key that uses the nonce). The relayer then pays the gas of the outer transaction. The facilitator has no limit per sender, per address or per failed settlement, and `/settle` for `exact` is open to everybody, so a funded account can repeat it until the relayer balance is gone; `/verify` is free for the attacker and costs several RPC views of the facilitator (rate limits of the free endpoints). The gas that is burnt is much less than the 100 Tgas that `maxSponsoredGas` allows (unused gas is refunded), but the limit is far above what an `ft_transfer` needs. Proposed: a lower `maxSponsoredGas`, a counter of failed settlements per sender with a pause, and a rate limit on `/verify` and `/settle`.
- Not checked: how `createFacilitatorNearSigner` picks and funds relayers, and what it does when the first relayer has no balance.
