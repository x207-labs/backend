# Broker class C and the TEE: what is built, what is not (BK-009, BK-010)

Status: **partial, honest.** This build has no TEE. Nothing here runs in an enclave, and no answer of the broker or of the client says otherwise.
Whoever operates a broker can read the provider secrets it holds (limit L8 of the pipeline backlog). What follows says which protections hold
without a TEE, how a client can ask for a TEE and be refused, and the concrete steps to a real one.

## 1. What is protected without a TEE (tested)

The secret of the grantor (the API key of the provider) lives in one environment variable of the broker process (`BROKER_PROVIDERS` names the variable;
`BROKER_SECRETS_FILE` can reload it on `SIGHUP`). From there it goes to one place: the provider the grant names.

| Protection | Where it is pinned |
| --- | --- |
| The lessee never receives the secret: not in the body, not in a header of the answer, not in an error | `test/proxy.test.ts` TC-BK-008-03 (scans body, headers and everything the broker sent to the network for the secret) |
| The secret is not in what the facilitator sees (`/verify`, `/settle`) | `test/proxy.test.ts` TC-BK-008-03 (traffic scan) |
| A provider that echoes the request headers cannot hand the secret back: the answer is redacted on the bytes, in the plain form and in common encodings | `test/secret-proxy.test.ts` TC-BE-078-P8 |
| The secret is not in the audit log (grant, asset type, method, path, status and the *version* of the secret only), and not in the structured log (names and shapes of secrets are redacted) | `test/proxy-multi.test.ts` TC-BK-011-04, `src/log.ts` |
| The secret is not in the database of the broker (`grants`, `calls`, `cursor`, `seen_events` hold no secret column) nor in D9 of the backend | `src/store.ts` (schema); the broker is a separate package and does not write to D9 |
| Only the owner of the broker can list a grant that spends its secret (`BROKER_SECRET_OWNER`) | `test/proxy.test.ts` (B7-P1, `403 grant_not_owned`) |
| A hosted demo broker holds no real secret: `BROKER_MODE=hosted` refuses a provider that is not a mock | `test/secret-proxy.test.ts` TC-BE-070-01, -02, TC-BE-078-P9 |
| A rotation changes the secret without cutting a grant; a rotation to an empty value is refused | `test/proxy-multi.test.ts` TC-BK-011-02, -03 |

What this does **not** protect: the operator of the broker (a person with a shell on the machine, a memory dump, a debugger, the process
environment), a compromised host, and a broker that is replaced by different code. The audit log is a plain file, not sealed. `POST /secrets`
(upload of a secret encrypted to an enclave key) is **not built**: the grantor puts the secret in the environment of a broker it runs itself.

## 2. The interface: `GET /attestation`

```
GET /attestation   ->  200 {"mode":"none","reason":"this broker does not run in a TEE: whoever operates it can read the secrets it holds"}
                       200 {"mode":"tee","quote":"<opaque quote>","codeHash":"<hash of the released broker code>"}   (only with an Attestor that has a quote)
```

Every deployment of this build answers `mode: "none"`. `startBroker({ attestor })` / `createBrokerHandler({ attestor })` take an `Attestor`
(`src/attest/index.ts`); the default is `NoAttestation`. The route is counted in `/metrics` as `route="attestation"` and listed in `docs/openapi.json`.

The client is `fetchAttestation(brokerUrl, { requireTee, expectedCodeHash, verifier })` (`src/attest/client.ts`):

- `mode: "none"` without `requireTee`: returned as it is, the caller decides. With `requireTee: true`: `AttestationError("tee_required")`.
- `mode: "tee"`: the word of the broker counts for nothing. The client needs a `verifier` and the `expectedCodeHash` of the released broker; without them it refuses (`no_verifier`),
  a different code hash is refused before the quote is looked at (`code_hash_mismatch`), and a quote that `verify` rejects is refused (`quote_invalid`).
- An answer that is not one of the two shapes, a non-200, and a redirect are refused (`bad_answer`).

`ClassCAdapter.prove()` is the same check on the broker side of a grant: without an attestor it answers `{ valid: false, reason: "no_attestation: …" }` and never `valid`.
Tests: `test/attestation.test.ts` (TC-BK-009-02 to -07) and `test/proxy.test.ts` (TC-BK-009-01).

## 3. The way to a real TEE (steps, not done)

Target: the broker runs inside a confidential VM whose measurement covers its code, `GET /attestation` returns a real quote, and the grantor seals the secret to a key
that exists only inside the VM. Two hosts are candidates; neither has been tried, so each step is a plan, and the quote format and the SDK calls must be checked against the
current documentation of the host before they are written.

Common steps:
1. Build the broker as a container image from a pinned base, with the lockfile; publish the image digest with the release (the release notes carry `codeHash`).
2. Define `codeHash` as the hash of what the host measures: the image digest plus the deployment file (compose or manifest). The client keeps this value as `expectedCodeHash`.
3. Implement `Attestor.quote()` by asking the guest agent of the host for a quote that binds a fresh public key of the enclave (a key made inside at start-up) and a nonce from the client
   (add `?nonce=` to `GET /attestation` so a quote cannot be replayed).
4. Implement `Attestor.verify()` in the client: check the quote against the hardware vendor's certificate chain (Intel TDX/DCAP, and NVIDIA for a GPU), check that the measurement
   equals `expectedCodeHash`, check the nonce and read the enclave public key from the report data.
5. Build `POST /secrets` (BK-009, second half): accepted only from the grantor (signature of the grant owner), the body is the secret encrypted to the enclave key, the broker keeps it only
   in memory or sealed to a key derived inside the VM, never in a log, never in the SQLite file in the clear (BK-010). Add the scan test of BK-010 for this route.
6. Seal the audit log to the same key (BK-011 left it open) and announce a code update through attestation: a new `codeHash` is published before it runs, and the client decides whether to trust it.

Host A, **Phala Cloud** (dstack): run the broker image as a compose app on a TDX confidential VM; the guest agent (a socket in the container) gives the quote and derived keys; the
compose hash is part of the measurement, so `codeHash` = hash of the compose file with the image digest in it. Steps: write `docker-compose.yml` with the digest, deploy to Phala Cloud,
call the guest agent from `Attestor.quote()`, verify with the dstack verifier or the DCAP libraries in `Attestor.verify()`.

Host B, **NEAR AI Cloud** (TEE-backed cloud of NEAR AI): deploy the same image on a confidential VM of the service and use the attestation report it exposes (CPU and GPU quotes), the
same steps 3 to 6. The reason to prefer it for this project is the fit with the NEAR track; the reason against is that the deployment API of a general workload must be confirmed with the
operator first. If a general workload cannot be run there, Phala (host A) is the fallback.

Until this is done, the README of the project says the same as this page: class C works, tested, with the secret in the process of the operator, and **no TEE**.
