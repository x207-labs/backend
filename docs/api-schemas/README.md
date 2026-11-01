# Skema read API dan settlement worker

`index.json` memetakan tiap endpoint Spec API Backend 2.1 dan 2.2 ke skema JSON (draft-07) di folder ini dan ke contoh di `examples/`. Test `test/api/schemas.test.ts` (TC-BE-014-15) memvalidasi semua contoh dan respons live.

Contoh `examples/` disalin dari Spec API Backend bagian 3–6. Penyimpangan dari contoh spec:

- `member.json` dan `members-list.json` memuat `exitRequestedEpoch` (Tambahan ADR-29..31 di spec).
- Spec tidak memberi contoh untuk `epochs-list`, `member-limits`, dan `params-history`. Bentuk item diturunkan dari kolom D9 (Spec Skema D9 3.4, 6.1, 6.7) dalam camelCase; `epochs-list` wajib memuat `epoch`, `phase`, `proposalDeadline` (K-41).
- `proposals`, `intents`, `bundles` belum punya skema: format menunggu BE-023 dan SD-047.
- Contoh intent/signedIntent bersifat sintetis; bentuk aslinya ditentukan SDK 1Click 0.1.26.

Fase `cutoff` dan `commit` pada `phase` epoch diturunkan dari waktu saat dibaca (`cutoff_at`, `proposal_deadline`), sedangkan D9 hanya menyimpan empat fase.
