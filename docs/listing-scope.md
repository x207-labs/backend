# Listing of an on-chain asset: what the backend checks (BE-049)

For the asset types that go to a class A escrow, a listing says exactly what will be put in escrow, in the form of the scope of the grant on the contract. The only free field of a listing is `detail`, so for these types it is JSON text. Types that do not start with one of the prefixes below are not looked at (a listing of `gpu-hours` with free text keeps working).

| Prefix of `offer.asset_type` | Catalogue | `detail.scope` |
| --- | --- | --- |
| `nft:` (`nft:ticket`, `nft:game-item`, `nft:coupon`, `nft:license`, …) | #1 to #5 | `{"nft_contract", "token_id"}` |
| `ft:` | #6 | `{"ft_contract", "amount"}` |
| `rwa:` | #7 | `{"ft_contract", "amount"}`; the contract must be in the whitelist of the circle |
| `lst:` | #8 | `{"ft_contract", "amount"}` |
| `mt:` | #9, #10 | `{"mt_contract", "token_id", "amount"}` |

`detail` is `{"scope": {…}, "valid_until": <unix seconds, optional>}`; any other key is refused.

## Rules
- `offer.asset_class` is `A` and `offer.quantity` is `1` (one token or one lot per listing).
- The asset type is registered in the registry of the circle (D10, `asset_class_set`) with class `A`; an unregistered type would be listed but its escrow could not start.
- The scope has exactly the keys of its shape, account ids are valid, `token_id` has 1 to 128 bytes, `amount` is a decimal string above 0 and not above u128 (the exact amount in the units of that token; the contract refuses any other amount).
- `nft:ticket` and `nft:coupon` carry `valid_until` in the future, and `listing.expires_at` may not be later than it. For any other type `valid_until` is optional but must be in the future.
- `rwa:` tokens must be in `rwaWhitelist` (option of `marketplaceRoutes`); with no whitelist every `rwa:` listing is refused. The whitelist is a decision of the circle, not of the token.
- An `mt:` listing of `nep141:<usdt>` held at the Intents contract is refused (needs the options `intentsId` and `usdtTokenId`); the contract refuses it too (`ERR_ESCROW_USDT`).

## Errors
`400 scope_invalid` with the reason in `message` and the fields in `details`. The class of the asset on the registry is not a new error: it is also `scope_invalid`.

## Limits
- Only the offered side is checked. The wanted side of a listing may name a typed asset, but its scope is not carried.
- The check does not look at the chain: it does not know that the token exists, that the seller owns it, or that the token contract takes a fee on transfer (the escrow cannot handle such a token, `contracts/docs/security-review.md`).
- The liquid staking exchange rate and the value of a liquidity share are information the front end may show; nothing here uses them.
