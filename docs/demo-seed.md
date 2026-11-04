# Demo data for the jury (BE-080)

`scripts/demo-seed.mjs` fills a backend with one example of every pipeline that runs, through the API of the backend. One command, idempotent, no secret in the repository.

```bash
npm run build
X207_DEMO_SEED=<a secret string kept outside the repo> X207_CONTRACT_ID=<circle contract> \
  X207_DEMO_SELLER=<account> X207_DEMO_BUYER=<account> X207_DEMO_HELPER=<account> \
  X207_API_URL=https://<your backend> npm run demo:seed
```

## What it posts
| Pipeline | What |
| --- | --- |
| batch 1, class A | an NFT (`nft:nep171`) and a fungible token (`token:nep141`), built with `buildAssetTemplate` of the SDK |
| P2, access rent | a class B listing `near-rpc:access` (the broker serves it with its mock provider) |
| P3, one-time code | a code listing; the code `DEMO-GIFT-0001` is checked by the mock issuer `demo-issuer` |
| P4, transfer | a game item (`trade_api`) and a ticket (`buyer_confirm`); a domain only with `--domain` and `X207_DEMO_DOMAIN`, because it needs the TXT `x207-sell=<listing_hash>` on a domain you control |
| P5, job | a metered resource listing `compute:gpu-hours` (class D, unit `job`, a mock endpoint) |
| P6, order | a research order of two milestones, signed by the buyer and the seller |
| P7, license | a dataset license listing |
| P8, invoice | an invoice of 60 credit in three installments, requested by the seller (the debtor approves in the page) |

## Before the first run
1. **The accounts.** The seed string gives the voucher keys of three accounts (`seller`, `buyer`, `helper`): `node scripts/demo-seed.mjs --print-members` prints each account with the public key it must join the circle with (`join` with `pubkey_voucher`). The script checks that each account is a member with that key, and posts nothing otherwise. The secret keys exist only in memory; the seed is never printed or logged.
2. **The backend.** Start it with the mock issuer for the code: `X207_CODE_MOCK_ISSUER=demo-issuer` and `X207_CODE_MOCK_CODES=DEMO-GIFT-0001` (BE-069, demo only). The class A asset types must be registered in the registry D10 of the circle (`set_asset_class`), or those two listings are refused and reported as failed.
3. **The open epoch.** The invoice needs an open epoch; the order and the listings do not.

## Idempotent
Every object has fixed content (names, nonces, amounts, and one fixed end date for all listings and milestones: `X207_DEMO_EXPIRES_AT`, default 2026-12-31T00:00:00Z), so its hash is the same on each run and the backend answers `already_exists` (`order_duplicate`, `invoice_duplicate`) for what is there. The output says `created`, `exists`, `skipped` or `failed` for each item and ends with the counts; the exit code is 1 when something failed. Change the end date only with a new, empty circle, or the listings are new ones.

## Limits
- The listings are real entries of the market but nothing is escrowed on the chain for the class A ones; they are for the page and the API, not for a purchase.
- The seed does not sell anything; a purchase needs the buyer to sign a voucher in the page or with the agents.
- Everything the pages show from this seed is labelled in its `terms` as a demo listing.
