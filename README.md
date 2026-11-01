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
