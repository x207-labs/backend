# Test-funds faucet (BE-114)

A new user logs in with Privy and gets an empty NEAR wallet. `join` needs 0.35 NEAR (the join deposit stays in the circle, see `adr-0.0.18.md` A-CT-01) and the stake needs mock USDT. The faucet gives both in one call.

Testnet only. The mock USDT (`usdt.x207-deployer.testnet`, `probes/mock_ft`) is not a real asset.

## API

### `POST /x207/faucet`

Body (JSON object, no other field):

| field | type | |
| --- | --- | --- |
| `account_id` | string | NEAR account id (lowercase, 2 to 64 characters) or a 64-hex implicit account. Required. |
| `include_usdt` | boolean | Default `true`. `false` sends NEAR only. |

`201`:

```json
{
  "account_id": "newbie.testnet",
  "near": { "amount_yocto": "600000000000000000000000", "tx": "<hash>" },
  "usdt": { "contract": "usdt.x207-deployer.testnet", "amount": "300000000", "txs": ["<storage_deposit hash>", "<mint hash>"] }
}
```

`usdt` is `null` when `include_usdt` is `false`. Amounts are strings in the smallest unit (yocto NEAR; USDT has 6 decimals, so `300000000` is 300 USDT; the wizard stakes 150).

Errors (the usual body `{"error": {"code", "message", "details"}}`):

| status | code | when | what the wizard does |
| --- | --- | --- | --- |
| 400 | `faucet_bad_account` | `account_id` missing or not an account id | fix the input |
| 400 | `invalid_request` | body is not an object, unknown field, `include_usdt` not boolean | fix the call |
| 404 | `faucet_account_not_found` | named account that does not exist (an implicit 64-hex account may not exist: the transfer creates it) | create the account first |
| 409 | `faucet_already_claimed` | this account has had a grant (one per account, ever) | go on to `join`; do not ask again |
| 409 | `faucet_already_funded` | the account holds more than 1 NEAR | go on to `join` |
| 429 | `rate_limited` | `details.scope` is `faucet_ip` (3 grants per address per rolling day) or `faucet_day` (100 grants per day for everybody); header `Retry-After` in seconds | show the wait time |
| 502 | `faucet_failed` | the network did not answer or the transfer failed; nothing was sent and nothing is reserved | try again |
| 502 | `faucet_partial` | the NEAR was sent, the USDT step failed; `details.near_tx` has the hash | send the same request again: it finishes the USDT and does not send NEAR twice |
| 503 | `faucet_empty` | the faucet account is below the reserve | try again later |

A faucet that is not configured has no route: `404 not_found`. `GET /x207/faucet` therefore doubles as the "is it on" check.

### `GET /x207/faucet`

```json
{ "enabled": true, "near_yocto": "600000000000000000000000", "usdt_amount": "300000000", "usdt_contract": "usdt.x207-deployer.testnet", "per_ip_per_day": 3, "per_day": 100, "remaining_today": 97 }
```

The faucet account name and its balance are not shown.

## How it stays safe

- Own account. `X207_FAUCET_ACCOUNT` is a small `*.testnet` account made for this, never the deployer. Its key is `X207_FAUCET_KEY`, only in the env file of the boxd unit (`/etc/x207/*.env`). It is read by `faucetFromEnv`, kept in the signer and never logged, stored or returned. The process refuses to start with an account that does not end in `.testnet` or with a mainnet RPC.
- Loss is bounded: the account holds a small balance; each grant is 0.6 NEAR plus 0.00125 for the USDT storage; the day cap is 100 grants (60 NEAR at most, in practice the balance). The faucet refuses to pay when the balance would fall under 2 NEAR (`X207_FAUCET_RESERVE_YOCTO`).
- Limits are reserved in one synchronous step before any network call: one grant per account (primary key of `faucet_grants`), per address per rolling day, grants per rolling day. Four parallel requests for one account give one grant (TC-BE-114-10). A request that is refused later (account not found, already funded, empty faucet, transfer failed) gives its slot back.
- The address is the one the abuse limiter uses: with `API_TRUST_PROXY=1` the last hop of `X-Forwarded-For` (boxd appends the real address; a forged header does not change it, see the BE-113 notes). In-memory limits of the other routes are not shared with the faucet; the faucet counts in SQLite and survives a restart.
- An account that holds more than 1 NEAR is refused (`X207_FAUCET_FUNDED_ABOVE_YOCTO`), so the faucet does not top up an account that already has money. This is a check of the moment, not of identity: someone can make many accounts. The per-address and per-day caps are what bound that. A Sybil with many addresses can drain the daily quota; that is the accepted cost of an open testnet faucet, and why the account balance is small.
- The server of the public demo is read-only. The faucet route carries `allowInReadOnly`; every other POST is still `404`.

## The alternative: the official faucet and a mint from the browser

| | Faucet in the backend (this) | Official testnet faucet + `mint` from the browser |
| --- | --- | --- |
| NEAR | paid from our small account | the wizard sends the user to a third-party faucet (captcha, its own limits, a login on some of them), outside our flow |
| USDT | `storage_deposit` + `mint` paid by the faucet | `ft_mint` of the mock is open (`mint(account_id, amount)` has no owner check), so the browser can call it, but the user needs NEAR first for `storage_deposit` and gas |
| steps for the user | one click | leave the app, solve a captcha, come back, sign two transactions |
| risk | a hot key on boxd, bounded by the balance and the caps | none for us; the open `mint` is a risk of the mock anyway |
| control | our caps, our logs | none |

Recommendation: the backend faucet. The NEAR is the part nobody can mint, and the point of onboarding is that the wizard does not send a new user away. Because `mint` is open, the USDT step could also be left to the browser; the backend does it so that the wizard has one call and the `storage_deposit` is paid by the faucet. If the owner does not want a hot key on boxd, the fallback is: the wizard links to the official faucet and offers a `mint` button; no backend change is needed for that.

## Environment

All in `docs/operations.md` (table `X207_FAUCET_*`). The faucet is off unless `X207_FAUCET_ACCOUNT` and `X207_FAUCET_KEY` are both set.

## Refill of the faucet account (BE-117)

`node dist/faucet/topup-cli.js` (`src/faucet/topup.ts` has the logic) runs on a systemd timer every 30 minutes on the machine of the faucet. If the balance of `X207_FAUCET_ACCOUNT` is under 3 NEAR it asks the official testnet faucet service (`https://helper.nearprotocol.com/account`, the one behind `near account create-account sponsor-by-faucet-service`) to sponsor a throwaway account (10 NEAR), then deletes that account with the faucet account as beneficiary, so the NEAR moves over. It repeats until the balance is over 8 NEAR, at most 3 accounts per run. If the service refuses, the run ends and the next one tries again (no tight retry). The throwaway key exists in memory only; the job does not read `X207_FAUCET_KEY`. The log has balances and transaction hashes only. Testnet only (it refuses a non-`.testnet` account and a mainnet RPC). Env: `X207_FAUCET_TOPUP_*` in `docs/operations.md`.

## Not done

- Not deployed to boxd. A key-holding endpoint needs the owner's permission.
- No check that the account really belongs to the person who asks (no proof of ownership): the grant goes to the account named in the body. Funding an account someone else owns is harmless for them.
- No per-account top-up after the first grant. A user who spends everything on gas needs a manual refill.
- The real adapter and the HTTP path were exercised on testnet with a new account `fct.alice.x207-v18-own.testnet` and small amounts (0.05 NEAR and 1 USDT to a fresh implicit account: `201`, the same account again `409 faucet_already_claimed`, an unknown named account `404`). The defaults of 0.6 NEAR and 300 USDT were not paid on testnet.
