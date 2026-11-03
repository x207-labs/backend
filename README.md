# x207 backend

Modul M5 (Settlement Worker) dan M6 (Indexer) x207, fitur F1–F7, proses P8, basis data baca D9. Bagian dari repo payung [`x207-labs/x207`](https://github.com/x207-labs/x207). M5 inti untuk F4 (F1 opsional); M6 inti untuk F1–F7.

| Folder | Isi |
| --- | --- |
| `src/indexer/` | Indexer event NEP-297 kontrak `x207-circle` |
| `src/api/` | Read API |
| `src/report207/` | Laporan HTTP `207 Multi-Status` |
| `src/settlement/` | Worker residual: `deposit`, `withdraw`, `claims` |
| `src/db/` | Skema dan migrasi D9 (SQLite) |

```bash
npm install
```

```bash
npm run build
```

```bash
npm test
```

Node ≥22.22.2. Konfigurasi lewat `.env` (daftar nama di `.env.example`); `.env` tidak pernah di-commit.

## CI
`@x207/core` comes from `sdk` and is not published, so a lone checkout cannot run `npm ci`. CI runs at the umbrella
workspace: `.github/workflows/ci-node-workspace.yml` in `x207-labs/x207` checks out the umbrella with its submodules,
puts the commit under test into `backend/`, and runs install, build and test at the root, where npm workspaces resolve
`@x207/core` from `sdk/packages/core`. It needs the repository secret `X207_CHECKOUT_TOKEN` (read access to every
private repository of the organization). `intents-sdk` asks for `typescript@^5` as a peer; the root lockfile resolves
it with `typescript@7.0.2` and `npm ci` at the root passes. The old `package-lock.json` of this folder is only for
local use outside the workspace.

## Menjalankan
Isi `.env` (`NEAR_RPC_PRIMARY_URL`, `X207_CONTRACT_ID`, `X207_START_BLOCK`, dan `X207_SETTLEMENT_MODE`; default `dry`), lalu:

```bash
npm run build && npm start
```

`src/main.ts` menjalankan indexer RPC, read API, endpoint settlement (deposit, withdraw, job) dan pemantau job dalam satu proses. Worker tidak memegang kunci.

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
| `API_MAX_OPEN_PURCHASES` | 50 | Purchases that are not final (`paid_held`, `cipher_posted`, `key_released`, `disputed`) of one buyer |

The broker has its own: `BROKER_ACCESS_RATE_PER_MINUTE_IP` (120), `BROKER_ACCESS_RATE_PER_MINUTE_GRANT` (60) and `BROKER_MAX_BODY_BYTES` (16384) for the routes `…/grants/{id}/access…`; the address of the peer is put in the header `x-x207-peer` by the server of the broker, which overwrites the one a caller sends.

Not covered: a caller with many addresses (a botnet) gets a quota per address; the reads of the chain that a route asks of the RPC (claims, `get_policy`) are bounded by the write limits only; the open caps count what the book holds, not what a signature could still create.

## OpenAPI (BE-068)
`docs/openapi.json` (OpenAPI 3.1) describes every route of the read API, the marketplace, the settlement worker and the broker, with the query parameters, the fields of the body, the status of success and the error codes per status (`x-error-codes`), among them 413, 429 and `open_limit_reached` of BE-066. It is **generated** from the sources: after you add or change a route run `npm run openapi` and commit the file. `test/api/openapi.test.ts` fails when the router and the document differ in either direction, or when the file is not what the script makes now; `broker/test/openapi.test.ts` does the same for the routes of the broker. Response bodies are loose (`object`) except the error envelope and the page `{items, nextCursor}`: the fields are in the spec 5a to 5h of the vault. The error codes of a route are what it can answer (the module's helpers included), a little more than one request will.
