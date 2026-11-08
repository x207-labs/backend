# Public read API on Railway (BE-089)

> **Superseded (UM-148):** the Railway trial ended and these services now run on the boxd machine `x207`, see [deploy/boxd](../../../deploy/boxd/README.md) in the umbrella repository. This page is kept for the record. Historical; transitive versions are not locked because the Dockerfile has no lockfile.

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
| `NEAR_RPC_PRIMARY_URL`, `NEAR_RPC_FALLBACK_URL` | `https://rpc.testnet.fastnear.com`, `https://near-testnet.drpc.org` |
| `X207_CONTRACT_ID`, `X207_CIRCLE_ID`, `X207_START_BLOCK` | `x207-v013.testnet`, `agents-main`, `276140918` |
| `X207_DB_PATH` | `/data/x207.sqlite` |
| `X207_READ_ONLY` | `1` (GET routes only; no settlement endpoints) |
| `X207_CORS_ORIGINS` | `https://x207-dashboard.vercel.app` (exact origin, no wildcard) |
| `API_TRUST_PROXY` | `1` (behind the proxy of Railway) |
| `X207_BLOCK_SOURCE`, `X207_NEARDATA_URL`, `X207_TX_INDEX_URL` | `account-index`, `https://testnet.neardata.xyz`, `https://tx.test.fastnear.com/v0/account` |

`X207_BLOCK_SOURCE=account-index` reads only the blocks of the transactions that the FastNEAR index lists for the contract (and the 8 after each), one request each 2.1 seconds, and stays 90 blocks behind the head. The default `rpc` source traces every transaction of every block and is for near-sandbox only.

## Check
```bash
curl https://x207.boxd.sh/healthz
curl https://x207.boxd.sh/x207/circles/agents-main/epochs
curl https://x207.boxd.sh/x207/circles/agents-main/members
```
`/metrics` is closed without `METRICS_TOKEN` since BE-108 (every call is 401); set `METRICS_TOKEN`, or `X207_METRICS_OPEN=1` to open it (counts of requests, not data).

## Redeploy with a replay (BE-091)
The hosted indexer read epoch 7 before it was pruned, so `edgesUnavailable` stays `false`. The prune transaction `5bDVKRKGJvemHiVdiN1Kjjxuj4zdfZh9MhSvWD5EbEPW` is in block 276185473 (receipts in 276185474 and 276185475). Deploy the build that has BE-091, then move the cursor back to that block so the indexer reads the call again.

1. Redeploy from the pushed code (same bundle steps as above, then `railway up --detach` from the bundle folder).
2. Rewind the cursor on the volume, once, with the service running the new build:
```bash
railway ssh --service x207-backend -- node -e "const D=require('better-sqlite3');const d=new D('/data/x207.sqlite');d.prepare(\"UPDATE indexer_cursor SET last_block_height = 276185473\").run();console.log(d.prepare('SELECT * FROM indexer_cursor').all())"
railway restart --service x207-backend
```
3. Check: `curl .../x207/circles/agents-main/epochs` shows epoch 7 with `edgesUnavailable: true`, `/healthz` shows `lagBlocks` back near 0, and the epoch 8 hash is unchanged.

The replay was rehearsed on a copy of the local read model (cursor set to 276185473, `epoch_pruned` rows removed, epoch 7 flag set to 0): the run read the prune again, wrote one `epoch_pruned` row (handled) and set epoch 7 back to `edges_unavailable = 1`. Rereading the blocks is safe: `events_raw` is INSERT OR IGNORE.
