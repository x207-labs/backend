# Operations runbook: backend and broker (BE-073)

For the person who runs the backend (indexer + read API + marketplace + settlement worker) and the broker. It says what to set, in what order to start, how to back up and restore, how to rotate a secret, and how to upgrade. Nothing here needs Docker. The commands are written for a Linux host with systemd; the owner's machine is not a place to run them for a test.

Two processes, two folders, two SQLite files:
- **backend** (`npm start` in `backend/`, `node dist/main.js`): indexer, read API, marketplace, settlement worker. File `X207_DB_PATH` (D9 read model and the marketplace books).
- **broker** (`npm start` in `backend/broker/`): leases and the P2/P3 accesses of one grantor. File `BROKER_DB_PATH`.
Both read the environment; neither reads a file of settings. Secrets only in the environment (`EnvironmentFile` with mode `0600`, owner the service user), never in git, never in a log (the logs are redacted, but do not count on it).

## Environment variables
"Secret" says whether the value is one: `yes` never goes in a ticket, a log or a chat; `maybe` can hold one (a URL with an API key in it, a path to a file of secrets); `no` is safe to show. The test `test/ops/env-table.test.ts` fails when this table and the code (backend and broker) do not name the same variables, and when a variable marked `yes` has a value in an `.env.example`.

| Variable | Process | Required or default | Secret | What it does |
| --- | --- | --- | --- | --- |
| `X207_CONTRACT_ID` | both | required | no | account of the circle contract |
| `X207_START_BLOCK` | backend | required | no | block of the deploy; the indexer starts here the first time |
| `X207_CIRCLE_ID` | both | default `agents-main` | no | circle id in the read model and the API paths |
| `X207_DB_PATH` | backend | default `x207.sqlite` | no | the SQLite file of the backend |
| `X207_API_HOST` | backend | default `127.0.0.1` | no | address the API listens on |
| `X207_API_PORT` | backend | default `8080` | no | port of the API |
| `X207_JOB_POLL_MS` | backend | default `15000` | no | poll of the settlement jobs |
| `X207_SETTLEMENT_MODE` | backend | default `dry` | no | `mock`, `dry` or `live` (1Click); `live` moves money |
| `X207_APP_FEES` | backend | none (no app fee) | no | JSON list of 1Click app fees |
| `X207_DAO_REGISTRY_PATH` | backend | none (empty registry) | no | JSON file of the DAOs that rent votes (BE-061) |
| `X207_CODE_SEEN_KEY` | backend | none (duplicate-code check off, warning at start) | yes | key of the HMAC of `code_seen` (BE-069) |
| `NEAR_RPC_PRIMARY_URL` | backend | required | maybe | main RPC; the URL may carry an API key |
| `NEAR_RPC_FALLBACK_URL` | backend | none | maybe | second RPC for the failover |
| `ONECLICK_BASE_URL` | backend | default `https://1click.chaindefuser.com` | no | 1Click API |
| `ONECLICK_JWT` | backend | none (quotes pay +25 bps) | yes | partner token of 1Click |
| `METRICS_TOKEN` | both | none (`/metrics` open) | yes | bearer token for `GET /metrics` |
| `API_LIMITS` | both | default `on` | no | `off` turns off every rate limit and open-object cap (tests only) |
| `API_RATE_LIMIT_PER_MINUTE` | backend | default `600` | no | requests per minute per IP |
| `API_WRITE_RATE_PER_MINUTE_IP` | backend | default `120` | no | POST per minute per IP |
| `API_WRITE_RATE_PER_MINUTE_ACCOUNT` | backend | default `60` | no | accepted writes per minute per account |
| `API_MAX_BODY_BYTES` | backend | default `65536` | no | largest body (413 above) |
| `API_MAX_PAGE_LIMIT` | backend | default `200` | no | largest `limit` of a list |
| `API_TRUST_PROXY` | backend | default off (`1` to turn on) | no | take the last `X-Forwarded-For` hop as the caller |
| `API_MAX_OPEN_ORDERS` | backend | default `50` | no | open orders per account |
| `API_MAX_OPEN_INVOICES` | backend | default `50` | no | open invoices per issuer |
| `API_MAX_OPEN_PURCHASES` | backend | default `50` | no | open purchases per buyer |
| `X207_READ_API_URL` | broker | required | no | URL of the read API of the backend |
| `X207_FACILITATOR_URL` | broker | required | no | URL of the facilitator (x402 `/verify`, `/settle`) |
| `NEAR_RPC_URL` | broker | required | maybe | RPC of the broker; the URL may carry an API key |
| `BROKER_ACCOUNT_ID` | broker | required | no | account of the broker (operator of the grants) |
| `BROKER_PRIVATE_KEY` | broker | required | yes | its key (`ed25519:…`) |
| `BROKER_LEASE_ACCOUNT_ID` | broker | required | no | sub-account that is leased (class B) |
| `BROKER_LEASE_PRIVATE_KEY` | broker | required | yes | the key that adds and deletes keys on it |
| `BROKER_PORT` | broker | default `8090` | no | port of the broker (it listens on 127.0.0.1) |
| `BROKER_DB_PATH` | broker | default `./broker.db` | no | the SQLite file of the broker |
| `BROKER_POLL_SECONDS` | broker | default `15` | no | sweep of lapsed leases and accesses |
| `BROKER_MODE` | broker | default `self-hosted` | no | `hosted` is the demo: mock providers only |
| `BROKER_PROVIDERS` | broker | none (class C off) | maybe | JSON list of class C providers; names the variables that hold their secrets |
| `BROKER_SECRETS_FILE` | broker | none | maybe | dotenv file of the provider secrets, re-read on `SIGHUP` |
| `BROKER_AUDIT_PATH` | broker | none (no file) | no | audit log, JSON lines without secrets |
| `BROKER_LIMITS` | broker | default `on` (or `API_LIMITS`) | no | `off` turns the rates of the access routes off |
| `BROKER_ACCESS_RATE_PER_MINUTE_IP` | broker | default `120` | no | access-route requests per minute per peer |
| `BROKER_ACCESS_RATE_PER_MINUTE_GRANT` | broker | default `60` | no | access-route requests per minute per grant |
| `BROKER_MAX_BODY_BYTES` | broker | default `16384` | no | largest body of an access route |

The variables named by `secret_env` in `BROKER_PROVIDERS` (for example `OPENAI_KEY`) are secrets too; they are not listed because the operator chooses their names. The P2 adapters (GitHub, Discord, AWS, OpenRouter, SSH) are created by the code that starts the broker with their tokens as arguments; keep those tokens in the same `EnvironmentFile`.

## Start order
1. **The contract is deployed and `X207_START_BLOCK` is its deploy block.** Wrong block = events are missed and not found later, because the indexer does not look back.
2. **Backend.** The process does, in this order: open the file and run the migrations of D9 (`schema_migrations`); `bootstrap` the indexer (creates the cursor and the first `params` from the view `get_params`); then start the API (`X207_API_HOST:X207_API_PORT`) and the settlement job monitor; the indexer loop runs after that and catches up in the background. So the API is up while the indexer is still behind: `GET /healthz` says `degraded` with the lag until it is caught up. Wait for `ok` (or for a lag you accept) before step 3. The marketplace migrations run when the routes are made, at the same start.
3. **Facilitator** (separate process, not in this folder) at `X207_FACILITATOR_URL`.
4. **Broker.** It needs the read API (the keys of the members, the active grants) and the facilitator. It starts with the database empty or full; its watcher reads `grant_*` events from the read API from its own cursor.
Stop in the reverse order: broker, facilitator, backend. The backend stops cleanly on `SIGTERM` (the indexer finishes its block); a hard kill is safe too, because one block is one transaction (BE-072). Start it with the real path of the file (`node /opt/x207/backend/dist/main.js`): the entry point compares `import.meta.url` with `process.argv[1]`, so a symlink to `main.js` would load the module and start nothing.

## Backup and restore
What is in the files, and what the chain can give back:
- **D9** (`members`, `epochs`, `obligations`, `events_raw`, …) is a read model: `rebuildReadModel` rebuilds it from `events_raw`, and `events_raw` can be read again from the chain *if the RPC still has the blocks* (a free RPC keeps days, not months).
- **The marketplace books** (`listings`, `offers`, `orders`, `invoices`, `purchases`, `purchase_complaints`, `code_checks`, `code_seen`, the held vouchers, the signatures) exist **only in this file**. The chain cannot give them back. A lost file means lost held vouchers and lost orders. Back up.
- The **broker** file holds the leases and the provider accesses (handles to take them back). Lose it and the broker cannot revoke what it opened: back it up too.

Take a backup (online, consistent, while the process runs; `cp` of a WAL file is not):
```bash
cd backend && npm run build
node scripts/db-backup.mjs backup /var/lib/x207/x207.sqlite /var/backups/x207/x207-$(date -u +%Y%m%dT%H%M%SZ).sqlite
```
It writes `…partial` and renames, refuses to overwrite, then prints the check. Run it from a timer (below) at least daily; keep the last 7 daily and 4 weekly, and copy them off the host (a backup on the same disk is not one). The files hold the same data as the live file: protect them the same way (mode `0600`).

Check any copy (also after copying it off the host):
```bash
node scripts/db-backup.mjs check /var/backups/x207/x207-20261104T020000Z.sqlite   # exit 1 when something is wrong
```
It runs `PRAGMA integrity_check`, looks for the tables the code needs, reads the cursor, and lists migrations that **this build does not know** (a copy from a newer build is refused: the migrations only go forward and an older build would run on tables it does not understand).

Restore (the process **must be stopped**):
```bash
systemctl stop x207-backend
mv /var/lib/x207/x207.sqlite /var/lib/x207/x207.sqlite.broken          # keep the old file until the new one is proven
rm -f /var/lib/x207/x207.sqlite-wal /var/lib/x207/x207.sqlite-shm     # a leftover log of the old file would be replayed over the restored one
node scripts/db-backup.mjs restore /var/backups/x207/x207-20261104T020000Z.sqlite /var/lib/x207/x207.sqlite
systemctl start x207-backend
curl -fsS http://127.0.0.1:8080/healthz
```
`restore` checks the copy first, copies to a temporary name and renames, and refuses an existing destination without `--force`. After the start the indexer goes on from the cursor of the backup and reads the blocks it missed: no event twice, none lost (tested: `test/db/backup.test.ts`, which loses the file, restores, continues indexing, and compares every table with a run that never stopped). What is lost is what was written between the backup and the loss and does not come from the chain: marketplace writes of that window (a listing, an order, a held voucher). Tell the people whose orders are younger than the backup. The broker restores the same way with its own file and `BROKER_DB_PATH`.

## Rotation of secrets
- **`X207_CODE_SEEN_KEY`** (HMAC of the codes already seen). The table `code_seen` keeps `HMAC-SHA256(key, issuer ‖ code)`; the backend does not keep the codes, so the old rows **cannot be re-keyed**. After a rotation: (a) a code checked **before** the rotation is no longer recognised, so the same code in a second listing is **not refused `code_duplicate`** any more; what still stops it is the check at the issuer (`code_used` once the first buyer redeemed it), the caps of 20 and 100 credit, the one hour window and the complaint; (b) codes checked after the rotation are compared with each other under the new key. Rotate when the key leaked (with the key and the table, someone can test guesses of low-entropy codes), not for hygiene. Do it when no code listing is open (`SELECT COUNT(*) FROM listings WHERE status = 'open' AND detail LIKE '%"kind":"code"%'` is 0), set the new key, restart the backend, and delete the old rows (`DELETE FROM code_seen`) so the dead rows do not stay. An empty key turns the check off with a warning in the log.
- **`METRICS_TOKEN`**: it is read at start and kept in memory. Change it in the `EnvironmentFile` of the backend **and** of the broker and in the scraper, restart both processes (the counters start at zero, as Prometheus expects). There is no overlap window: the scraper gets 401 between the restart and its own change; set the scraper first to the new token if it can hold two, otherwise accept a gap of a minute.
- **Provider secrets of the broker** (class C, `secret_env` of `BROKER_PROVIDERS`): put the new value in `BROKER_SECRETS_FILE` and send `SIGHUP` (`systemctl kill -s HUP x207-broker`). The broker re-reads the file and rotates every provider; no grant is cut; the audit log records the rotation (names, never values). A failed rotation (the variable is empty) keeps the old secret.
- **`BROKER_PRIVATE_KEY`, `BROKER_LEASE_PRIVATE_KEY`** (keys on NEAR accounts): add a new access key to the account first (`near account add-key …`), put the new private key in the `EnvironmentFile`, restart the broker, check `GET /healthz` and one lease, then delete the old key from the account. Never delete the old key before the broker runs on the new one: the broker could not then revoke what it holds.
- **Tokens of the P2 adapters** (GitHub, Discord, AWS, OpenRouter management key): change them in the `EnvironmentFile` and restart the broker. An access that is open keeps working at the provider (its handle does not change); a revoke made while the old token is dead is retried by the manager (`revoke_pending`) and succeeds after the restart.
- **`ONECLICK_JWT`, the API key inside `NEAR_RPC_*_URL`**: change the value and restart the backend.

## Upgrade with migrations
Migrations only go **forward** and run at start (D9 versions 1 to 10, marketplace 1101 and up, in the same table `schema_migrations`). There is no downgrade. So the safe order is:
1. `node scripts/db-backup.mjs backup …` of the backend file (and of the broker file if the broker changes). Run `check` on the copy.
2. Build the new version next to the old one. Run `node scripts/db-backup.mjs check <copy of the live file>` with the NEW build: `pendingVersions` is what the next start will apply, `unknownVersions` must be empty. Try the start on that copy (`X207_DB_PATH=<copy> X207_API_PORT=0`) before the real one.
3. Stop broker, then backend. Switch to the new build. Start backend (it migrates), wait for `GET /healthz` `ok`, start broker.
4. Roll back = stop, put the old build back **and restore the backup of step 1**. Do not run the old build on a file the new one migrated: the old build does not know the new tables or columns, ignores the new versions in `schema_migrations`, and may write rows that the new schema refuses. `check` run by the old build on the migrated file prints the unknown versions and exits 1: use it as the guard in a script.
5. A migration that rebuilds a table (`ALTER TABLE … RENAME`) runs in one transaction and needs the free disk of the size of that table.

## Examples (to write down, not to run here)
`/etc/systemd/system/x207-backend.service`:
```ini
[Unit]
Description=x207 backend (indexer, read API, marketplace)
After=network-online.target
Wants=network-online.target

[Service]
User=x207
Group=x207
WorkingDirectory=/opt/x207/backend
EnvironmentFile=/etc/x207/backend.env
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
StateDirectory=x207
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/x207

[Install]
WantedBy=multi-user.target
```
`/etc/systemd/system/x207-broker.service` (starts after the backend answers):
```ini
[Unit]
Description=x207 access broker
After=x207-backend.service
Requires=x207-backend.service

[Service]
User=x207
WorkingDirectory=/opt/x207/backend/broker
EnvironmentFile=/etc/x207/broker.env
ExecStartPre=/usr/bin/curl --silent --fail --retry 30 --retry-delay 2 --retry-connrefused http://127.0.0.1:8080/healthz
ExecStart=/usr/bin/node dist/main.js
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/x207-broker

[Install]
WantedBy=multi-user.target
```
`/etc/systemd/system/x207-backup.service` and `.timer` (daily, off-host copy is yours to add):
```ini
# x207-backup.service
[Service]
Type=oneshot
User=x207
WorkingDirectory=/opt/x207/backend
ExecStart=/bin/sh -c 'node scripts/db-backup.mjs backup /var/lib/x207/x207.sqlite /var/backups/x207/x207-$(date -u +%%Y%%m%%dT%%H%%M%%SZ).sqlite'
ExecStartPost=/usr/bin/find /var/backups/x207 -name "x207-*.sqlite" -mtime +7 -delete

# x207-backup.timer
[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
```
`Procfile` (for a host that uses one process per line; the order of start is yours to keep):
```
web: node dist/main.js
broker: node broker/dist/main.js
```
with the environment of each from its own file (`set -a; . ./backend.env; set +a` before the line, or the environment of the platform). The broker is `cd broker && node dist/main.js` in systemd because its `BROKER_DB_PATH` default is relative.

## What to watch
`GET /healthz` of both (a probe every 30 s: alert on `down`, and on `degraded` for more than 10 minutes); `x207_indexer_lag_blocks` and `x207_indexer_seconds_since_update`; `x207_broker_revoke_queue{kind="lease"|"provider_due"}` above 0 for more than two polls (an access that should be closed is open); `x207_rate_limited_total` rising (an attack or a limit that is too low); the size of the backup folder and the age of the newest backup.
