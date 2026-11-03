# Pemetaan kolom D9 ke field D1/D2/D4/D5/D7

Setiap kolom read model D9 (migrasi `src/db/migrations.ts`) terlacak ke field penyimpanan data di Model Data (D1 registry anggota, D2 ledger kewajiban, D3 registry voucher, D4 log kliring, D5 catatan settlement, D6 pool stake, D7 parameter) atau ditandai `teknis` (kunci, penunjuk blok, bukti receipt). Spec: Spec Skema D9 bagian 3. Diperiksa oleh `TC-BE-004-09`.

Tabel infrastruktur `events_raw`, `indexer_cursor`, dan `settlement_jobs` bukan proyeksi D1–D7 dan tidak dipetakan di sini.

| Tabel | Kolom | Field D | Catatan |
| --- | --- | --- | --- |
| circles | circle_id | teknis | Kunci lingkaran di path API |
| circles | contract_id | teknis | Akun kontrak `x207-circle` |
| circles | network | teknis | `x207:<circle_id>` |
| members | circle_id | teknis | Kunci multi-lingkaran |
| members | account_id | D1 `account_id` | |
| members | pubkey_voucher | D1 `pubkey_voucher` | |
| members | terms_hash | D1 `terms_hash` | Hash syarat yang disetujui saat `join` |
| members | stake | D1 `stake` | Ditimpa dari event |
| members | credit_limit | D1 `limit` | Dinamai `credit_limit` karena `LIMIT` kata kunci SQL |
| members | outstanding_debt | D2 `outstanding_debt[account]` | Dari `epoch_committed`, `member_defaulted` |
| members | status | D1 `status` | `pending`/`active`/`suspended`/`exited` (ADR-26) |
| members | admitted | D1 `admitted` | `MemberView.admitted` (admission = dao) |
| members | settled_history | D1 `settled_history` | |
| members | joined_at_ns | D1 `joined_at` | |
| members | exit_requested_epoch | D1 `exit_requested_epoch` | ADR-29 |
| members | reactivate_epoch | D1 `status` | ADR-30 (P1): epoch status kembali `active` |
| members | updated_block | teknis | Blok pembaruan terakhir |
| member_limits | id | teknis | Urutan riwayat |
| member_limits | circle_id | teknis | |
| member_limits | account_id | D1 `account_id` | |
| member_limits | epoch | D1 `limit` | Epoch perubahan limit; NULL di luar finalisasi |
| member_limits | old_limit | D1 `limit` | |
| member_limits | new_limit | D1 `limit` | |
| member_limits | status | D1 `status` | Status anggota saat perubahan |
| member_limits | reason | D1 `limit` | Penyebab: `stake`/`finalize`/`default` |
| member_limits | block_height | teknis | |
| member_limits | receipt_id | teknis | |
| member_limits | log_index | teknis | |
| epochs | circle_id | teknis | |
| epochs | epoch | D4 `epoch` | |
| epochs | phase | D4 `epoch` | `open`/`clearing`/`payment_window`/`finalized` |
| epochs | cutoff_at_ns | D7 `epoch_length` | Batas epoch dari `next_cutoff_at` |
| epochs | closed_at_ns | D4 `epoch` | Waktu `close_epoch` |
| epochs | proposal_deadline_ns | D7 `proposal_window` | `epoch_cutoff.proposal_deadline` (K-41) |
| epochs | committed_at_ns | D4 `epoch` | Waktu `commit_epoch` |
| epochs | payment_deadline_ns | D7 `payment_window` | commit + `payment_window` |
| epochs | finalized_at_ns | D5 `status` | Waktu `epoch_finalized` |
| epochs | edge_count | D2 `obligation` | Jumlah edge saat cutoff |
| epochs | total_obligation | D2 `obligation` | Σ kewajiban saat cutoff |
| epochs | cleared_total | D4 nilai terhapus | |
| obligations | circle_id | teknis | |
| obligations | epoch | D2 `obligation` | |
| obligations | debtor | D2 `obligation` | Kunci `(debtor, creditor)` |
| obligations | creditor | D2 `obligation` | |
| obligations | seq | D3 `seq` | Voucher terdaftar terakhir |
| obligations | cumulative_amount | D2 `obligation` | Kewajiban sebelum kliring (ADR-17) |
| obligations | cleared | D4 nilai terhapus | NULL sampai `clearing_applied` |
| obligations | registration_mode | D3 `seq` | `cumulative`/`per_request` |
| obligations | registered_block | teknis | |
| obligations | receipt_id | teknis | |
| clearing_log | circle_id | teknis | |
| clearing_log | epoch | D4 `epoch` | |
| clearing_log | solver | D4 `solver` | |
| clearing_log | cleared_total | D4 nilai terhapus | |
| clearing_log | fee | D7 `fees` | `clearing_fee + solver_fee` |
| clearing_log | edge_count | D4 proposal `edges` | Edge dengan `cleared > 0` |
| clearing_log | block_height | teknis | |
| clearing_log | applied_at_ns | D4 `epoch` | Waktu penerapan proposal |
| clearing_log | tx_hash | teknis | Hash tx dari indexer |
| clearing_log | receipt_id | teknis | |
| settlements | circle_id | teknis | |
| settlements | epoch | D5 `net_position[epoch]` | |
| settlements | account_id | D5 `net_position[epoch][account]` | |
| settlements | role | D5 `net_position` | `debtor`/`creditor`/`none` |
| settlements | net | D5 `net_position` | Bertanda: negatif = net debtor |
| settlements | amount | D5 `net_position` | `|net|` |
| settlements | cleared | D4 nilai terhapus | Σ cleared pada edge masuk anggota |
| settlements | status | D5 `status` | `due`/`paid`/`defaulted`/`claimable`/`claimed` (ADR-26) |
| settlements | due_at_ns | D7 `payment_window` | Batas bayar |
| settlements | paid_amount | D5 `status` | Jumlah dibayar (`residual_paid`) |
| settlements | stake_slashed | D6 stake | `member_defaulted.from_stake` |
| settlements | reserve_used | D6 cadangan | `member_defaulted.from_reserve` |
| settlements | shortfall | D5 `status` | `member_defaulted.shortfall` |
| settlements | haircut | D5 `status` | 0 selama limit ≤ stake |
| settlements | destination | D5 `status` | `ClaimDestination` `near`/`intents` |
| settlements | tx_hash | teknis | Hash tx dari indexer (ADR-32 K-15) |
| settlements | updated_block | D5 `updated_at_block` | |
| params | id | teknis | Urutan riwayat |
| params | circle_id | teknis | |
| params | field | D7 nama field | Termasuk `proposal_window`, `limit_cap`, `limit_decay` |
| params | old_value | D7 nilai lama | NULL untuk baris awal |
| params | new_value | D7 nilai baru | JSON |
| params | effective_epoch | D7 `effective_epoch` | |
| params | block_height | teknis | |
| params | receipt_id | teknis | `init:<block>` untuk baris awal |
| params | log_index | teknis | |

## escrows (migrasi 4 dan 6, CT-075 dan CT-090)
Satu baris per escrow kelas A, kunci `(circle_id, grant_id)`. `kind` `nft` mengisi `nft_contract` dan `token_id`; `kind` `ft` (event `ft_escrow_held`, interface 0.0.10) mengisi `ft_contract` dan `amount`; `kind` `mt` (event `mt_escrow_held`, CT-092, migrasi 7) mengisi `mt_contract`, `token_id` dan `amount`. `amount` berupa teks desimal dalam satuan token itu (bukan credit) karena token 18 desimal melewati 2^63; pemeriksaan batas 2^63 di ingest tidak berlaku untuk kedua event ini, handler memeriksa 1..2^128-1. `state` berpindah lewat `grant_activated` (delivered), `grant_revoked` (cancelled) dan `escrow_failed` (held atau stuck), sama untuk kedua jenis. Read API: `escrow` pada `GET …/grants` dan `…/grants/{id}` berisi `{kind:"nft", nftContract, tokenId, state}`, `{kind:"ft", ftContract, amount, state}` atau `{kind:"mt", mtContract, tokenId, amount, state}`.

## intent_book dan intent_withdrawals (migrasi 5, BE-045)
`intent_book`: hash intent per circle dengan `status` `posted` atau `removed`. `intent_withdrawals`: satu baris per `intents_withdrawn`.
