# Listing of an on-chain asset: what the backend checks (BE-049)

For the asset types that go to a class A escrow, a listing says exactly what will be put in escrow, in the form of the scope of the grant on the contract. The only free field of a listing is `detail`, so for these types it is JSON text. Types that do not start with one of the prefixes below are not looked at (a listing of `compute:gpu-h100` with free text keeps working).

| `asset_type` (registry D10, `scripts/lib/asset-catalog.mjs`) | Catalogue | Delivery method | Scope keys at the top of `detail` |
| --- | --- | --- | --- |
| `nft:nep171`, `ticket:event-nft`, `game:item-nft`, `coupon:voucher-nft`, `license:software-nft` | #1 to #5 | `escrow_nft` | `nft_contract`, `token_id` |
| `token:nep141`, `lst:liquid-staking` | #6, #8 | `escrow_ft` | `ft_contract`, `amount` |
| `rwa:tokenized` | #7 | `escrow_ft` | `ft_contract`, `amount`; the contract must be in the whitelist of the circle |
| `intents:multi-token` | #9 | `escrow_mt` | `mt_contract`, `token_id`, `amount` |
| `amm:lp-share` | #10 | `escrow_ft` or `escrow_mt` | `ft_contract`, `amount` (`standard` `nep141`) or `mt_contract`, `token_id`, `amount` (`nep245`) |

The shape follows the delivery method of the entry, not a prefix of the name. `detail` is the flat JSON that `buildAssetTemplate` of the SDK writes (SD-061): the scope keys at the top level, next to display keys (`kind`, `decimals`, `symbol`, `display`, `event`, `name`, `game`, `description`, `product`, `terms_hash`, `seats`, `whitelist`, `rate_info`, `label`, `pool`, `value_info`, `standard`) that are not checked, except `kind` (it must match the asset type) and, for a license, `terms_hash` and `seats` (well formed when given). Asset types that are not in the table are not looked at. A test compares the table with the catalogue and builds every listing with the real `buildAssetTemplate`, so the two cannot drift apart.

## Rules
- `offer.asset_class` is `A` and `offer.quantity` is `1` (one token or one lot per listing).
- The asset type is registered in the registry of the circle (D10, `asset_class_set`) with class `A`; an unregistered type would be listed but its escrow could not start.
- The scope has exactly the keys of its shape, account ids are valid, `token_id` has 1 to 128 bytes, `amount` is a decimal string above 0 and not above u128 (the exact amount in the units of that token; the contract refuses any other amount).
- A ticket carries `event.ends_at` (the SDK writes the end of the event there; `valid_until` is accepted too) and a coupon carries `valid_until`, both in the future, and `listing.expires_at` may not be later than them. For any other type `valid_until` is optional but must be in the future.
- `rwa:tokenized` tokens must be in `rwaWhitelist` (option of `marketplaceRoutes`); with no whitelist every `rwa:tokenized` listing is refused. The whitelist is a decision of the circle, not of the token.
- An `intents:multi-token` listing of `nep141:<usdt>` held at the Intents contract is refused (needs the options `intentsId` and `usdtTokenId`); the contract refuses it too (`ERR_ESCROW_USDT`).

## Errors
`400 scope_invalid` with the reason in `message` and the fields in `details`. The class of the asset on the registry is not a new error: it is also `scope_invalid`.

## Limits
- Only the offered side is checked. The wanted side of a listing may name a typed asset, but its scope is not carried.
- The check does not look at the chain: it does not know that the token exists, that the seller owns it, or that the token contract takes a fee on transfer (the escrow cannot handle such a token, `contracts/docs/security-review.md`).
- The liquid staking exchange rate and the value of a liquidity share are information the front end may show; nothing here uses them.
