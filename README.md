# x207 backend

Modul M5 (Settlement Worker) dan M6 (Indexer) x207, fitur F1–F7, proses P8, basis data baca D9. Bagian dari repo payung `x207-labs/x207`.

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
