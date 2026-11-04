# x207 Access Broker (M10, F8)

Module **M10**, feature **F8** (access asset adapter), part of [x207](https://github.com/x207-labs/x207). Per ADR-36 the broker lives in this
folder of `backend` and is not a repository of its own; a repository is split off later if the broker gets its own operator and
deployment target (TEE).

Built here: class B, the lease of a NEAR function-call key. The lessee pays a day of rent with an ordinary x207 voucher to the
grantor (`payTo` = grantor, `extra.grantId`, `resource` = `x207:grant:<grantId>`); the broker never touches D2 or D3.

| Folder | Content | Status |
| --- | --- | --- |
| `src/watcher/` | reads `grant_activated`, `grant_revoked`, `member_defaulted` from the read API (BK-003) | built |
| `src/keys/` | class B: `AddKey` and `DeleteKey` on the lease sub-account (BK-006, BK-007) | built |
| `src/proxy/` | class C (BK-008): `POST /grants/{grantId}/proxy/*` checks the grant, the scope and the quota of the epoch, forwards the call with the secret of the grantor and settles only when the provider answered with success | built, **no TEE** |
| `src/attest/` | class C (BK-009): the `Attestor` interface and `NoAttestation` | interface only |

```bash
npm install   # from the repository root, workspaces
npm test
npm run build && npm start
```

Variables are in `.env.example`.

## Class C: what it is and what it is not
The secret of the grantor (the API key of the provider) is read from the environment variable that `BROKER_PROVIDERS` names. **There is no
TEE in this build and no attestation**: whoever runs the broker can read the secret, and `prove` for class C answers `no_attestation`
unless a real `Attestor` is given. The sealing of secrets to an enclave key (BK-009, BK-010) and the upload endpoint `POST /secrets`
are not built. What is built is checked against a local mock provider: the secret is sent to the provider only, never back to the lessee,
never to the facilitator, and a scan of responses and facilitator traffic in `test/proxy.test.ts` finds none.

**Whose secret (B7-P1).** The secret of a provider is the secret of the owner of this broker (`BROKER_SECRET_OWNER`, default `BROKER_ACCOUNT_ID`). A class C grant whose `grantor` is another account is refused `403 grant_not_owned` before any payment is asked, for every provider that is not marked `mock`; otherwise any member could list a grant for the same asset type and be served, and paid for, with the key of the owner. Mock providers (the demo) are served for any grantor.

**Limits and the bill (B7-P3, P4, P6).** The provider is called after `/verify` and before `/settle` (that is the order of the scheme), so a call can be made and then not paid when the settle fails: the lessee gets `402`, the call is **not** counted (`usage` and the quota give it back) and the audit log writes `unbilled_call`. An answer of `204`, `205` or to a `HEAD` is passed on without a body. A body of a proxied call is capped at 4 MiB (`413 payload_too_large`, checked on the declared length before the chain is asked and read only after the payment passed), an answer of the provider at 8 MiB (`502 provider_response_too_large`, not billed), and the proxy and `usage` routes count 120 requests per minute per address and 60 per grant (`429 rate_limited`, `Retry-After`). `GET /grants/{id}/usage` still answers anyone; it shows the calls per epoch of a grant and nothing else.

`limits.scope` of a class C grant is `{"path_prefixes": ["/v1/echo"], "methods": ["GET", "POST"]}`, `limits.quota` is the number of calls
per epoch, `unit` is `call`.

### Several providers, rotation, audit log (BK-011)
- Several providers are served at once: one entry per asset type in `BROKER_PROVIDERS`, each with its own secret variable.
- **Secrets and `hosted` (BE-070, ADR-48).** A real key stays on the broker that its owner runs. `BROKER_MODE=hosted` is for the demo: an entry of `BROKER_PROVIDERS` must carry `"mock": true` (a local server with a made-up secret), otherwise the broker does not start (`ConfigError`), and a call through a provider that is not a mock answers `501 secret_hosted_forbidden` before anything is paid or sent. An empty secret variable is `502 secret_not_configured` (the message names the variable, never a value).
- **The bill per call.** A call is billed (the voucher is settled) only when the provider answered below 300; a status of 400 or more, an unreachable provider, and a redirect (`502 provider_redirect`: the broker never follows or passes on a redirect, because it could lead to another host) are not billed and give the quota slot back. `GET /grants/{id}/usage` returns `{unit: "call", unitPrice, calls, billed, epochs: [{epoch, calls}]}`: the number of calls that were settled and their cost, which a buyer compares with its own count (SD-068); the count and the bill are the same number.
- **A key of an AI provider (#61)** is shared only through the official sub-key feature of the provider (confirmed by the owner, ADR-48 point 4). `OpenRouterSubkeyAdapter` (`provider: "openrouter-subkey"`, register it like the other P2 adapters) makes a NEW key with the Management API (`POST /api/v1/keys {name, limit (USD), limit_reset}`) and deletes it at the end of the paid day (`DELETE /api/v1/keys/{hash}`). The scope of the grant: `resource` is the credit limit in USD (`"5"`), `permission` is `daily` (default), `weekly` or `monthly`; the limit is the most the lessee can spend per period, and `maxLimitUsd` (default 50) caps what a grant may ask. The key is shown to the lessee once, in the answer of the first day (`delivery.key`); a renewal keeps it and answers `key: null`. The Management key of the grantor stays on the broker and is in no answer, no record. The access is marked `not_applicable` with the warning `grantee_unproven` (the lessee has no account at the provider). Checked against the documentation of OpenRouter on 2026-11-03 (create, list, read, update, delete, response with `data.hash` and the top-level `key`); the single-key read is assumed to answer `{data: …}` as the create does; **not run against the real API**. Limits: `expires_at` is fixed at creation and the rent is renewed daily, so the end is the deletion by the broker, not a native expiry; `cost` reads `usage_daily` and is exact for today only.
- Rotation: `providers.rotate(assetType, newSecretEnv)` (or SIGHUP with `BROKER_SECRETS_FILE`) points the provider at the new secret. Grants name an
  asset type, not a secret, so no grant is cut and the quota keeps counting. A rotation to an empty variable is refused and the old secret stays.
- Audit log (`BROKER_AUDIT_PATH`, JSON lines): calls, refusals and rotations with grant, asset type, method, path, status and the version of the secret.
  It holds no secret, no header and no body. **It is not encrypted**: sealing it to an enclave key needs the TEE this build does not have, and the
  broker still runs without any TEE or attestation. The update of broker code announced through attestation is not built either.

## P2: delegated access to a service (BE-057, ADR-47)
`src/provider/` gives one interface, `ProviderAccessAdapter { grant, revoke, status, verifyGranteeRef }`, for every provider, and `ProviderAccessManager` on top of it. The grant on the contract says who may use what for how long (`limits.scope` is JSON `{provider, grantee_ref, resource?, permission?, daily_cap?}`); the adapter makes the provider say the same.
- **`verifyGranteeRef` first.** A reference the provider does not know gets no access (`grantee_ref_unverified`), so a grant cannot be pointed at an account nobody checked (ADR-47: a grant that is sold on is cut at the reference).
- **Native expiry.** An adapter whose provider has an expiry of its own (SSH `expiry-time=`, presigned URL, STS session) MUST set it to the paid end; the manager undoes a grant whose adapter did not (`native_expiry_required`). If the broker is down at the end of the day the provider still closes the access.
- **`revoke_pending`.** A revoke that fails is kept and tried again at 30 s, 60 s, 120 s … up to one hour, until it works; `sweep()` (run in `tick()`) does both the clock and the retries. The access also closes when the contract revokes the grant or the lessee defaults (watcher events).
- **Costly access.** `settleDay` asks the provider for the real cost of a day (`adapter.cost`), writes it down once per day for the bill, and closes the access (`cap_exceeded`) when a day passed `daily_cap` of the scope.
- **Mode.** `BROKER_MODE=self-hosted` (default): the grantor runs the broker and the administrator token of a provider stays on that machine. `hosted`: demo only, and `register` refuses an adapter with `real = true` (`hosted_mode_real_provider`).
- `MockProviderAdapter` is the generic mock (failures on demand, native expiry, cost per day).

Not built: an HTTP route that hands a provider access to a lessee after a payment (the manager is called by code; the lease server of class B is untouched), and the `once` handover of the groups without an API (those use BE-047).

### Accounts-free adapters (BE-058)
- **`SshAdapter`** (`provider: "ssh"`): `grantee_ref` is the OpenSSH public key of the lessee (type and blob checked, no newline or option can ride in it), `resource` is the forced command. The line written to `authorized_keys` is `restrict,command="<cmd>",expiry-time="YYYYMMDDHHMMSSZ" <key> x207-grant-<id>`: `restrict` turns off forwarding and the pty, the command is the only thing the key may run, and sshd refuses the key after `expiry-time` with the broker gone. `revoke` removes only the line of that grant. Self-hosted only (it writes the file of the machine).
- **`S3PresignedAdapter`** (`provider: "s3-presigned"`): `resource` is the object key; the URL is signed locally with AWS Signature V4 (checked against the example of the AWS documentation), and S3 refuses it after `X-Amz-Expires` (the paid end, at most 7 days). **Limit:** a presigned URL cannot be taken back; `revoke` only forgets it, so the loss is at most the paid day.

### Adapters with a real API (BE-059)
All three are `real`, so they are refused in `hosted` mode; the administrator credential is read by the code that builds the adapter, from the environment of the machine that runs the broker, and appears in no delivery, log line or error text (errors name method, path and status, and cut the answer).
- **`GithubAdapter`** (`github`): `resource` `owner/repo` + `permission` (`pull`, `triage`, `push`, `maintain`, `admin`) is a collaborator invitation; `org:<org>` is a seat. `allowedOwners` limits the broker to the accounts the grantor names. `verifyGranteeRef` looks the login up (`GET /users/{login}`).
- **`DiscordAdapter`** (`discord`): `grantee_ref` is a user id that must already be a member of the guild; `resource` is the role id (`allowedRoleIds` names the roles the broker may give). A rate limit (429) is an error with `retryAfter`, retried by the manager.
- **`AwsStsAdapter`** (`aws-sts`): `resource` is a role ARN in `allowedRoleArns`. `iam:GetRole` is read first and the role must carry the configured permissions boundary; the session (`AssumeRole`, at most 12 h, never under the STS floor of 900 s) gets a narrower session policy and ends by itself. Requests are signed with SigV4 (`signPost`). Limit: a session cannot be taken back before it ends.
- Tests use a mock `fetch`. Two more run against the real accounts of the owner when EVERY variable they need is in the `.env` of the project root (otherwise they are skipped): `GITHUB_TEST_TOKEN`, `GITHUB_TEST_ORG`, `GITHUB_TEST_REPO`, `GITHUB_TEST_GRANTEE` (invites that user to that repository as a collaborator, permission `pull`), and `DISCORD_TEST_BOT_TOKEN`, `DISCORD_TEST_GUILD_ID`, `DISCORD_TEST_GRANTEE_ID`, `DISCORD_TEST_ROLE_ID` (gives that role to that user). Access goes only to the grantee named there, is taken back at the end also when the test fails (`afterAll`), and no value is printed.

### HTTP rent of a P2 access (BE-060)
Routes on the same server as the lease of class B. `provider` must be given to `startBroker` (it always is); without it the paths answer `501 class_not_supported`. Errors are `{error, message}`.

| Route | What |
| --- | --- |
| `POST /grants/{grantId}/access` | Body `{grantee_ref, proof?}`. Without a voucher: `402` for **one day**, `payTo` the grantor, `extra.grantId` (the same x402 flow as the lease). With the voucher of the lessee: the access is opened (or its end moved one day) and the voucher is settled only if that worked. `200`: the view below plus `delivery` (what the lessee needs to use the access; never a secret of the grantor). |
| `GET /grants/{grantId}/access` | The view. `404 access_not_found` before the first payment. No authentication: nothing in it is secret. |
| `POST /grants/{grantId}/access/stop` | Body `{notice, signature}`; notice is canonical JSON with keys `circle, grant_id, actor, action, at`, `action` is `stop`, `circle` is the account of the contract, `actor` the lessee, `at` unix seconds within 600 s of the broker clock. The signature is the NEP-413 style signature of the SDK over `nep413SigningHash(json, sha256(json), circle)` with the voucher key of the lessee (read from the read API). `200`: the view (`revoked`, or `revoke_pending` if the provider failed). Safe to repeat. |

View: `{grantId, provider, granteeRef, status ("active"|"revoke_pending"|"revoked"), paidUntil, providerExpiresAt, reason, revokePending: null | {attempts, nextRetryAt, lastError}, today: {day, cost, billed}, unit: "credit", decimals: 6}`. `today.cost` is the real cost since 00:00 UTC in the smallest unit (`null` if the access costs nothing); `today.billed` is the bill written down for the day (after `settleDay`).

Rules: the grant must be active on the chain; `limits.scope` must be a provider scope (JSON `{provider, grantee_ref, resource?, permission?, daily_cap?}`); `body.grantee_ref` must equal `scope.grantee_ref` (the reference is fixed on the chain, so an access cannot be moved to another account); the payer of the voucher must be the lessee; an adapter that has `proveGranteeRef` needs a `proof` that passes on the first day (not on the next days).

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | `invalid_request` | body or notice malformed, `at` too far from the clock |
| 400 | `scope_invalid` | the scope of the grant is not a provider scope |
| 401 | `invalid_signature` | `stop` not signed by the voucher key of the lessee |
| 403 | `grantee_ref_mismatch` | `grantee_ref` differs from the scope |
| 403 | `payer_not_grantee` | the voucher is from another account |
| 403 | `grantee_ref_unverified` | the provider does not know the ref, or the proof failed |
| 403 | `not_grantee` | `stop` from an account that is not the lessee |
| 404 | `access_not_found` | no access for this grant |
| 404, 403 | `grant_not_found`, `grant_not_active`, `grant_revoked` | the grant on the chain (nothing is charged) |
| 409 | `voucher_in_flight` | the same voucher is paying another request |
| 409 | `access_conflict` | the access of this grant already ended (`revoked`, `expired`), or another grant already holds the same access (same provider and `grantee_ref`): nothing is charged; wait until it ends |
| 501 | `provider_unknown`, `hosted_mode_real_provider`, `class_not_supported` | no adapter for the provider, a real provider in hosted mode, or routes not wired |
| 502 | `native_expiry_required`, `provider_grant_failed`, `provider_unavailable` | the provider refused or failed to open the access (`provider_grant_failed`), or did not set its expiry; nothing is settled |

### Limited rent of the vote of a DAO (BE-061)
`DaoVoteAdapter` (`provider: "dao-vote"`). The holder of the tokens (the grantor) delegates its voting power to the lessee for **one kind of vote** per grant; the scope is `{provider: "dao-vote", grantee_ref: <account of the delegate>, resource: <account of the DAO>, permission: <vote kind>}`.
- **Registry D10 per DAO:** `{ "<DAO account>": { "rentable_vote_kinds": [{ "kind": "gauge_weight", "contract": "<contract that handles only that kind>" }] } }`. The circle's governance gives it to the backend (`X207_DAO_REGISTRY_PATH`), which serves it at `GET /x207/circles/{circle}/marketplace/dao-registry`; the broker reads it from there at every grant (`fetchDaoRegistry`), so a decision of the governance applies at once and a grantor who runs the broker cannot write what a DAO allows. `daoRegistryFromFile` is for tests and for the `hosted` mode with mock providers only. A DAO with no list refuses every rent (`vote_kind_forbidden`); a DAO that is not in the registry is `dao_unknown`.
- **Only a scoped delegation.** A general delegation (most DAOs, Sputnik token-weighted included) covers every proposal, the treasury too, so it cannot be rented. The adapter delegates only at the `contract` of the kind. A kind with no `contract` (or with the DAO itself as the contract) is refused with `delegation_not_scoped`.
- **Never for rent:** `treasury`, `code_upgrade`, `council`. A registry that lists one of them is refused when it is loaded (`DaoRegistryError`), and the adapter refuses them again at the grant (`vote_kind_forbidden`).
- **Revocation and record:** the broker takes the delegation back at the end of the paid day or on `stop`; the holder can take it back on the DAO at any time (`status` is then `absent`). The delivery `{dao, contract, kind, delegate, record}` names where the votes are public.
- `DaoClient` is the interface to the DAO contract (`delegate`, `undelegate`, `isDelegated`, `accountExists`, `recordOf`). The tests use a mock DAO; a client for a real DAO contract is not built. Where the governance writes the file for the backend (and that nothing on the chain holds it) is a limit: the contract does not change.
- Errors added to the P2 routes: `vote_kind_forbidden`, `dao_unknown` and `delegation_not_scoped`, all HTTP 403.

### Proof of the `grantee_ref` (BE-057)
The reference is fixed in the scope of the grant on the chain. When an access is opened, the adapter checks that the lessee controls it (`proveGranteeRef`, with the format of the SDK: `encodeGranteeProof`, `docs/daily-rent.md`). The proof is asked once, on the first day.
- **Challenge:** `GET /grants/{id}/access/challenge` gives `{required, grantId, circle, granteeRef, nonce, challenge, expiresAt}` for a provider that needs one (`github`, `ssh`); `{required: false}` for the others. The text is `granteeChallenge` of the SDK (it binds circle, grant, reference and a nonce of the broker). One live challenge per grant, 15 minutes; **the first proof that is checked uses it up**, so a proof cannot be tried again or replayed (`grantee_ref_unverified`: "tantangan …").
- **`ssh`** (`ssh-signature`): a raw ed25519 signature of the challenge by the private key of the public key that is the reference (`signSshChallenge`).
- **`github`** (`near-gist`): a public gist of the account named by the reference holds `buildGistContent` (the challenge signed with the voucher key of the lessee). The broker fetches `https://api.github.com/gists/<id>` only (the host is fixed, only the hex id comes from the proof) behind the SSRF guard (`provider/ssrf.ts`, a copy of the guard of the backend: https, public addresses, no redirect, 256 KiB, 5 s), checks the owner, and checks the signature against the voucher key that the circle has for the lessee.
- **`discord`** (`oauth`): the user id that Discord reports for the OAuth token (`discordIdentify`, `identify` scope) must be the reference. **Without `oauth` the reference cannot be proven:** the access opens with the warning `grantee_unproven` in the answer of `POST …/access` (`warnings`) and `proof: "unproven: …"` in the record and in the view.
- **`mock`**: always proven. **`dao-vote`**: the account that receives the delegation must be the grantee of the grant (the account that signs the vouchers of the lessee); no proof is sent.
- The view has `proof`: `verified`, `unproven: …`, or `not_applicable` (an adapter with no proof at all: S3 presigned, AWS STS); anything but `verified` also puts `warnings: ["grantee_unproven"]` in the view of `GET …/access`. The challenge is used up by a verdict only: an error of GitHub (5xx, 403, timeout) leaves it for another try, and the gist is read with the token of the grantor.
- The SSH adapter accepts `ssh-ed25519` keys only (the proof is a raw ed25519 signature). A GitHub access that was there before the grant (a collaborator, an organization member) is not removed when the rent ends; the handle holds the grant id, the invitation id and that flag. Errors are `grantee_ref_unverified` (403); the message names the failure. Added to the routes: `GET /grants/{id}/access/challenge`.
- Limit: the SDK text of the challenge has no `expires_at`; the broker enforces the 15 minutes on its side.

## Limits against abuse (BE-066)
The access routes (`/grants/{id}/access…`) have a rate per address of the peer (`BROKER_ACCESS_RATE_PER_MINUTE_IP`, default 120), a rate per grant (`BROKER_ACCESS_RATE_PER_MINUTE_GRANT`, 60) and a body cap (`BROKER_MAX_BODY_BYTES`, 16384, answered `413 payload_too_large`); a request over a rate is `429 rate_limited` with `Retry-After`. They are in the memory of one process: two brokers each count for themselves. **`API_LIMITS=off`** (the variable of the backend) or `BROKER_LIMITS=off` (the broker's own, which wins) turns both rates off for tests that send many requests; the body cap stays. The address of the peer is put in the header `x-x207-peer` by the server of the broker, which overwrites the one a caller sends.
