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
| `src/proxy/` | class C: forwarding with the secret inside the enclave (BK-008..BK-010) | roadmap |
| `src/attest/` | class C: TEE attestation (BK-011) | roadmap |

```bash
npm install   # from the repository root, workspaces
npm test
npm run build && npm start
```

Variables are in `.env.example`.
