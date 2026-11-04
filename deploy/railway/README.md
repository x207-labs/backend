# Public read API on Railway (BE-089)

One service: the read API and the indexer that follows the testnet circle `x207-v013.testnet`, GET only, with a Railway volume at `/data` for the SQLite read model. No broker, no signing key, no secret: every variable below is a public value.

## Build the folder and deploy
```bash
npm run build                                   # the backend; build ../sdk/packages/core first
node scripts/railway-bundle.mjs /tmp/x207-railway <read model sqlite>   # the seed: a read model of the circle without the marketplace tables
cd /tmp/x207-railway
railway init --name x207-backend
railway add --service x207-backend --variables "X207_READ_ONLY=1" ...   # the variables below
railway volume add --mount-path /data
railway domain
railway up --detach
```
The first start copies the seed to the volume (`start.sh`); later starts keep the volume.

## Variables
| Variable | Value |
| --- | --- |
| `NEAR_RPC_PRIMARY_URL`, `NEAR_RPC_FALLBACK_URL` | `https://rpc.testnet.fastnear.com`, `https://rpc.testnet.near.org` |
| `X207_CONTRACT_ID`, `X207_CIRCLE_ID`, `X207_START_BLOCK` | `x207-v013.testnet`, `agents-main`, `276140918` |
| `X207_DB_PATH` | `/data/x207.sqlite` |
| `X207_READ_ONLY` | `1` (GET routes only; no settlement endpoints) |
| `X207_CORS_ORIGINS` | `https://x207-dashboard.vercel.app` (exact origin, no wildcard) |
| `API_TRUST_PROXY` | `1` (behind the proxy of Railway) |
| `X207_BLOCK_SOURCE`, `X207_NEARDATA_URL`, `X207_TX_INDEX_URL` | `account-index`, `https://testnet.neardata.xyz`, `https://tx.test.fastnear.com/v0/account` |

`X207_BLOCK_SOURCE=account-index` reads only the blocks of the transactions that the FastNEAR index lists for the contract (and the 8 after each), one request each 2.1 seconds, and stays 90 blocks behind the head. The default `rpc` source traces every transaction of every block and is for near-sandbox only.

## Check
```bash
curl https://x207-backend-production.up.railway.app/healthz
curl https://x207-backend-production.up.railway.app/x207/circles/agents-main/epochs
curl https://x207-backend-production.up.railway.app/x207/circles/agents-main/members
```
`/metrics` is open (no `METRICS_TOKEN`: the variables are public values only); it holds counts of requests, not data.
