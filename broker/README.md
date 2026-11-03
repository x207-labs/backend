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

`limits.scope` of a class C grant is `{"path_prefixes": ["/v1/echo"], "methods": ["GET", "POST"]}`, `limits.quota` is the number of calls
per epoch, `unit` is `call`.

### Several providers, rotation, audit log (BK-011)
- Several providers are served at once: one entry per asset type in `BROKER_PROVIDERS`, each with its own secret variable.
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
