# Prosedur uji jalur residual (BE-026)

`intents.testnet` tidak punya kode (Spike Test Results S3.1), jadi jalur residual tidak bisa diuji di testnet. Urutannya: tanpa jaringan, tanpa dana, lalu satu transaksi nominal kecil di mainnet setelah konfirmasi manusia. Dokumen ini hanya prosedur; tidak ada langkah yang dijalankan otomatis oleh test suite.

Mode worker (`X207_SETTLEMENT_MODE`, lihat `src/settlement/config.ts`):

| Mode | Jaringan | Dana | Dipakai untuk |
| --- | --- | --- | --- |
| `mock` | tidak | tidak | Tahap 1 |
| `dry` (default) | 1Click nyata, `dry: true` dipaksa | tidak | Tahap 2 dan 3 |
| `live` | 1Click nyata, `dry: false` diizinkan | ya | Tahap 4 saja |

## Tahap 1 — mock (`FX-1C`)

```bash
npm test
```

Lulus berarti pemetaan quote, error, dan ambang pencairan benar terhadap rekaman Ronde 3 (B1.x, B2.x). Syarat masuk tahap 2.

## Tahap 2 — `simulate_intents` (view, tanpa dana)

`simulate_intents` di `intents.near` adalah view; dipanggil lewat `simulateIntents(view, signed)` di `src/settlement/intents.ts` dengan `rpcViewFunction(NEAR_RPC_PRIMARY_URL)`.

1. Siapkan `signed`: daftar intent bertanda tangan. Untuk probe awal boleh `[]` (hasil S2.7: `intents_executed: []`, membuktikan view terjangkau).
2. Untuk residual, intent `ft_withdraw` / transfer dibuat oleh `OneClickClient.generateIntent(...)` lalu ditandatangani kunci pemilik di wallet; worker tidak memegang kunci.
3. Lulus bila `ok: true`. `ok: false` dengan `code: "simulation_failed"` berisi pesan error view; perbaiki intent, jangan lanjut.

## Tahap 3 — quote `dry: true`

Env: `X207_SETTLEMENT_MODE=dry`, `ONECLICK_BASE_URL`, `ONECLICK_JWT` (opsional; tanpa JWT quote kena +25 bps, tetapi `dry` tetap 201).

Parameter yang sudah teruji di Ronde 3:

| Arah | `depositType` | `recipientType` | Hasil yang diharapkan |
| --- | --- | --- | --- |
| Masuk (stake / `due`) | asal apa pun yang didukung | `INTENTS` | 201 + `depositAddress`; tujuan `nep141:usdt.tether-token.near` |
| Keluar kreditor | `INTENTS` | `DESTINATION_CHAIN` | 201; `withdrawFee` `"2400"` ke USDC Base, `"900000"` ke USDT Tron |

Aturan wajib:

- `refundTo` harus akun yang ada. Akun yang tidak ada menyebabkan internal error 1Click (R1.5). Cek dengan `view_account` dulu.
- Header `User-Agent` wajib; tanpa itu 1Click menjawab `error code: 1010`.
- Pencairan ke Base di bawah 0,25 USD (`"250000"`) ditolak worker (`below_withdraw_threshold`); meneruskan `amountOut` dari quote `dry` ke `evaluateWithdrawThreshold` menghasilkan estimasi kerugian yang sama dengan angka 1Click.
- Tidak ada `generate-intent` / `submit-intent` pada tahap ini.

Catat `amountIn`, `amountOut`, `withdrawFee`, `timeEstimate` tiap quote. Selisih besar dari tabel B2.1–B2.5 dicatat di Spike Test Results sebelum lanjut.

## Tahap 4 — satu residual nominal kecil di mainnet (konfirmasi manusia)

Hanya dijalankan setelah tahap 1–3 lulus dan pemilik menyetujui secara eksplisit, di chat, untuk transaksi ini (nominal, akun, arah). Persetujuan satu kali tidak berlaku untuk transaksi berikutnya.

Batas keamanan:

- Nominal: jalur keluar ke Base pakai di atas ambang (mis. 1 USDT, kerugian ~0,38%); jalur masuk pakai nominal terkecil yang dapat dilihat (mis. 1 USDT).
- Akun: akun uji milik pemilik, bukan akun anggota lingkaran produksi.
- Worker dijalankan dengan `X207_SETTLEMENT_MODE=live` hanya selama transaksi, lalu dikembalikan ke `dry`.
- Penandatanganan oleh pemilik di wallet. Kunci tidak disimpan di `.env` worker.

Langkah (keluar, kreditor):

1. Quote `INTENTS` → `DESTINATION_CHAIN` dengan `dry: true`; tampilkan `withdrawFee` ke pemilik.
2. Setelah pemilik setuju: quote `dry: false`, `generateIntent`, pemilik menandatangani, `submitIntent`.
3. Pantau `status(depositAddress)` sampai status akhir (`SUCCESS`, `REFUNDED`, atau `FAILED`).

Langkah (masuk, `due` atau stake): quote `recipientType: INTENTS`, pemilik mengirim ke `depositAddress`, tunggu saldo Intents, lalu `buildFtWithdraw` (tanpa `msg`) dan `buildFtTransferCall` dengan `stakeMsg` / `settleMsg` (ADR-19), semuanya ditandatangani pemilik.

## Bukti yang dicatat (di vault, bukan di repo)

Per tahap: tanggal UTC, mode, hasil (lulus atau gagal), `amountIn` / `amountOut` / `withdrawFee`, dan untuk tahap 4 tx hash serta status akhir 1Click. Jangan mencatat JWT, kunci, atau isi `.env`.

BE-026 selesai bila tahap 1–3 lulus dan tahap 4 sukses sekali. Dokumen ini adalah prosedurnya; eksekusi tahap 4 menunggu persetujuan pemilik dan belum dilakukan.
