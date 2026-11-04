# x207 backend

Modules M5 (Settlement Worker) and M6 (Indexer) of x207, features F1–F7, process P8, read database D9. Part of the umbrella repo [`x207-labs/x207`](https://github.com/x207-labs/x207). M5 is core for F4 (F1 optional); M6 is core for F1–F7.

| Folder | Contents |
| --- | --- |
| `src/indexer/` | NEP-297 event indexer for the `x207-circle` contract |
| `src/api/` | Read API |
| `src/report207/` | HTTP `207 Multi-Status` report |
| `src/settlement/` | Residual worker: `deposit`, `withdraw`, `claims` |
| `src/db/` | D9 schema and migrations (SQLite) |

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

Node ≥22.22.2. Configuration goes through `.env` (variable names listed in `.env.example`); `.env` is never committed.

## CI
`@x207/core` comes from `sdk` and is not published, so a lone checkout cannot run `npm ci`. CI runs at the umbrella
workspace: `.github/workflows/ci-node-workspace.yml` in `x207-labs/x207` checks out the umbrella with its submodules,
puts the commit under test into `backend/`, and runs install, build and test at the root, where npm workspaces resolve
`@x207/core` from `sdk/packages/core`. It needs the repository secret `X207_CHECKOUT_TOKEN` (read access to every
repository of the organization). `intents-sdk` asks for `typescript@^5` as a peer; the root lockfile resolves
it with `typescript@7.0.2` and `npm ci` at the root passes. The old `package-lock.json` of this folder is only for
local use outside the workspace.

## Running
Fill in `.env` (`NEAR_RPC_PRIMARY_URL`, `X207_CONTRACT_ID`, `X207_START_BLOCK`, and `X207_SETTLEMENT_MODE`; default `dry`), then:

```bash
npm run build && npm start
```

`src/main.ts` runs the RPC indexer, the read API, the settlement endpoints (deposit, withdraw, job) and the job monitor in one process. The worker holds no keys.

## Read model against the testnet circle (BE-079)
`scripts/testnet-v013.mjs` runs the real indexer from the first transaction of the circle `x207-v013.testnet` (interface 0.0.13) into a SQLite file and compares the read model with the views of the contract: members, epochs, obligations, cleared edges (`proposal_hash`, `edge_count`), positions, and the fee charged on stake (`members.stale`, `fee_mismatches`). It reads blocks and views only; it sends no transaction and uses no key. Prints a JSON report.

```bash
npm run build
READMODEL_DB=/tmp/x207-testnet-v013.sqlite node scripts/testnet-v013.mjs x207-v013.testnet > report.json
```

A second run with the same `READMODEL_DB` reads only new blocks; `REBUILD=1` replays the stored events with the current handlers (no network). The free neardata endpoint is slow (500 blocks take 8 to 10 minutes). Details and a recorded run: [`docs/testnet-v013.md`](docs/testnet-v013.md). Demo data for this read model: [`docs/demo-seed.md`](docs/demo-seed.md) (demo only).

## Public testnet API (BE-089)
The read API and the indexer of the testnet circle `x207-v013.testnet` (interface 0.0.13) run on Railway, GET only, at **https://x207-backend-production.up.railway.app** (for example `/healthz`, `/x207/circles/agents-main/epochs`, `/x207/circles/agents-main/members`). CORS is open for `https://x207-dashboard.vercel.app` only. It is a read model of a testnet: no signing key, no broker, no settlement endpoints, only public values in its variables. How it is built and set up: [`deploy/railway/README.md`](deploy/railway/README.md).

## Live quote of 1Click (BE-090)
A residual that a creditor withdraws to another chain is quoted by 1Click through `POST /x207/settlement/withdraw/quote`. With `X207_SETTLEMENT_MODE=dry` (the default) the call is always `dry: true`: 1Click answers the price and makes no deposit address, and **no funds move**. `scripts/live-quote.mjs` serves that route over a read model and asks for one quote of 5 credit to USDC on Base:

```bash
npm run build
node scripts/live-quote.mjs --db <read model sqlite>      # reads one active member of the circle; no key, no JWT
```

Real output, 2026-11-04 08:31:30 UTC, without a JWT (1Click adds 25 bps to a quote without one; it did not ask for one):

```json
{
  "time_utc": "2026-11-04T08:31:30.300Z",
  "mode": "dry",
  "one_click": "https://1click.chaindefuser.com",
  "jwt": "none",
  "status": 201,
  "answer": {
    "jobId": "aa63e519-f7d4-4037-941c-6c130d147f9e", "status": "quoted", "dry": true, "unit": "credit", "decimals": 6,
    "originAsset": "nep141:usdt.tether-token.near",
    "destinationAsset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    "depositType": "INTENTS", "recipientType": "DESTINATION_CHAIN",
    "amountIn": "5000000", "amountOut": "4989148", "withdrawFee": "2400",
    "variableFeeBpsEstimate": 14, "totalFeePct": 0.217,
    "threshold": { "chain": "base", "minAmount": "250000", "ok": true },
    "timeEstimateSeconds": 14, "warnings": []
  }
}
```
The request that the script sent (the same as `curl -X POST $BACKEND/x207/settlement/withdraw/quote -H 'content-type: application/json' -d '…'`): `{"circle":"agents-main","account":"m00.x207-v013-aux.testnet","destinationAsset":"nep141:base-0x8335…2913.omft.near","amount":"5000000","recipient":"0x2CfF…2680","refundTo":"near","dry":true}`. The account is a member of the testnet circle `x207-v013.testnet`, `refundTo` is an existing mainnet account (the route checks it), and the recipient is an example address. 5 credit in gives 4.989148 USDC out: the fixed fee is 0.0024 and the variable part about 14 bps. The route stops at the quote: `submit` needs `X207_SETTLEMENT_MODE=live` (`422 live_mode_disabled` in `dry`).

## Limits against abuse (BE-066)
All limits live in the memory of one process. **With two instances behind a balancer each one counts for itself**, so the real ceiling is the number of instances times the value; a shared store (Redis) is not part of this version. Set them in `.env`; a value of 0 turns a rate limit off.

| Variable | Default | What it limits |
| --- | --- | --- |
| `API_RATE_LIMIT_PER_MINUTE` | 600 | All requests per IP (429 `rate_limited`, header `Retry-After`) |
| `API_WRITE_RATE_PER_MINUTE_IP` | 120 | Write requests (POST) per IP, accepted or not |
| `API_WRITE_RATE_PER_MINUTE_ACCOUNT` | 60 | Write requests an account gets **accepted** per minute. A request that fails its checks or its signature does not count, so nobody can use up the quota of an account by naming it. The account is read from the body (`notice.actor`, `listing.account`, `intent.account`, `offer.proposer`, `referral.seeker`, `voucher.payer`, `order.buyer`, `account`); a body that names none is limited by IP only |
| `API_MAX_BODY_BYTES` | 65536 | Largest body; above it `413 payload_too_large` (minimum 1024) |
| `API_MAX_PAGE_LIMIT` | 200 | Largest `limit` of a list (400 above it; the code never serves more than 200) |
| `API_TRUST_PROXY` | off | `1` takes the last hop of `X-Forwarded-For` as the caller; only behind a proxy you run, or anyone can pick the address that is counted |
| `API_MAX_OPEN_ORDERS` | 50 | Orders `proposed` or `open` that one account is a party to (409 `open_limit_reached`) |
| `API_MAX_OPEN_INVOICES` | 50 | Invoices `requested` or `approved` that one account issued |
| `API_LIMITS` | on | **`off` turns off every rate limit and every cap on open objects at once** (for tests that send many requests, e.g. the e2e of the umbrella); it overrides the variables above; the size of a body (`API_MAX_BODY_BYTES`) and of a page stay. `on` or empty: as set. Any other value is an error at start |
| `API_MAX_OPEN_PURCHASES` | 50 | Purchases that are not final (`paid_held`, `cipher_posted`, `key_released`, `disputed`) of one buyer |

The broker reads `API_LIMITS=off` too (or `BROKER_LIMITS=off`, which wins); it has its own: `BROKER_ACCESS_RATE_PER_MINUTE_IP` (120), `BROKER_ACCESS_RATE_PER_MINUTE_GRANT` (60) and `BROKER_MAX_BODY_BYTES` (16384) for the routes `…/grants/{id}/access…`; the address of the peer is put in the header `x-x207-peer` by the server of the broker, which overwrites the one a caller sends.

Not covered: a caller with many addresses (a botnet) gets a quota per address; the reads of the chain that a route asks of the RPC (claims, `get_policy`) are bounded by the write limits only; the open caps count what the book holds, not what a signature could still create.

## OpenAPI (BE-068)
`docs/openapi.json` (OpenAPI 3.1) describes every route of the read API, the marketplace, the settlement worker and the broker, with the query parameters, the fields of the body, the status of success and the error codes per status (`x-error-codes`), among them 413, 429 and `open_limit_reached` of BE-066. It is **generated** from the sources: after you add or change a route run `npm run openapi` and commit the file. `test/api/openapi.test.ts` fails when the router and the document differ in either direction, or when the file is not what the script makes now; `broker/test/openapi.test.ts` does the same for the routes of the broker, which are in the extension `x-broker-paths` (another server; `/healthz` and `/metrics` exist on both, so they cannot share `paths`). Response bodies are loose (`object`) except the error envelope and the page `{items, nextCursor}`: the fields are in the spec 5a to 5h of the vault. The error codes of a route are what it can answer (the module's helpers included), a little more than one request will.

## Health, metrics and logs (BE-071)
- `GET /healthz`: `{status, db, indexer: {lagBlocks, lastBlockHeight, secondsSinceUpdate, stale}, rpc, problems}`. `ok` and `degraded` (indexer more than 100 blocks behind, its cursor not written for 120 s, or the RPC probe failing) are `200`; `down` (the database does not answer, or the indexer has not bootstrapped) is `503`. The RPC probe asks `get_params` of the circle contract at most every 10 s. `GET /x207/health` (BE-014) is unchanged.
- `GET /metrics`: Prometheus text. `x207_http_requests_total{method,route,code}` and `x207_http_request_duration_seconds_sum` (the label `route` is the route **pattern**, `unmatched` for a path that matches none, so hashes and accounts never become series), `x207_rate_limited_total{scope}` (the 429, by the limit that refused: `ip`, `ip_write`, `account_write`), `x207_indexer_lag_blocks`, `x207_indexer_last_block_height`, `x207_indexer_seconds_since_update`, `x207_db_up`, `x207_process_start_time_seconds`. A request is counted when it is over, so a scrape does not see itself. With `METRICS_TOKEN` set, `/metrics` needs `Authorization: Bearer <token>`; `/healthz` stays open for probes. Counters are per process.
- Logs: `src/log.ts`, one JSON object per line on stderr (`ts`, `level`, `msg`, fields). One line per request with the route pattern, the status, the time and the address of the caller; **never the path, the query or the body**. A field named like a secret (key, token, secret, signature, password, authorization, cookie, seed, private, …) is replaced whole; every string, in a field or in the message, has the shapes of secrets replaced (`ed25519:…`, `Bearer …`, `sk-…`, `ghp_…`, JWT, `token=…`). Public keys under a name such as `pubkey_voucher` are kept. A 500 is logged with its error (redacted); the answer to the caller stays `internal_error`.
- The broker has `GET /healthz` (the database, and the revoke queues), `GET /metrics` (`x207_broker_http_requests_total{method,route,code}`, `x207_broker_rate_limited_total`, `x207_broker_revoke_queue{kind="lease"|"provider"|"provider_due"}`, `x207_broker_leases_open`, `x207_broker_provider_access_active`, `x207_broker_db_up`; the same `METRICS_TOKEN`) and the same JSON lines with the same redaction.

## The indexer after a kill (BE-072)
One block is one SQLite transaction (the events of the block, their handlers and the move of the cursor), so a kill in the middle of a block, with `SIGKILL` too, leaves the file as it was before that block; the next start reads that block again. A log is stored once by `(receipt_id, log_index)`. Only final blocks are read: the height comes from `finality: final` and the client refuses a block above the final head of its endpoint. A source that errs is asked again with a backoff that doubles up to a ceiling (`maxBackoffMs`, 30 s by default) while the cursor stays. Tests: `test/indexer/resilience.test.ts` (a handler that dies at each point, a child process killed with `SIGKILL`, a restart after every block, blocks delivered twice, a dead source) compare the tables with a run without a disturbance.
