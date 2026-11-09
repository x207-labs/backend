# Supabase: account data of the dashboard (BE-116)

What lives here: a profile name, the onboarding steps, notification preferences and feedback of a user, kept in Supabase and reached only through one Edge Function. Money, credit, members and settlement are not here; they stay on the contract and in the backend.

```
supabase/
  migrations/20261109000000_x207_account_tables.sql   tables, RLS, grants
  functions/x207-account/
    index.ts      Deno entry: CORS, body limit, Supabase client (service role), RPC
    handler.ts    the logic (actions, validation, rate limit); no Deno or Supabase inside
    nep413.ts     NEP-413 verification with WebCrypto only
```

Tests: `npx vitest run test/supabase` (Node, no Deno needed; `handler.ts` and `nep413.ts` import nothing but each other).

## Objects

Every object ends in `_x207`. The project also holds `reeve_docs` and `reeve_ledger` of another project; nothing here touches them.

| table | columns |
| --- | --- |
| `profiles_x207` | `account_id` text pk, `display_name` text (1 to 40), `created_at`, `updated_at` |
| `onboarding_x207` | `account_id` text pk, `wallet_created`, `funds_received`, `joined`, `staked`, `tour_done` (boolean, default false), `updated_at` |
| `notify_prefs_x207` | `account_id` text pk, `email` text null (max 254), `deadline_reminder` boolean, `updated_at` |
| `feedback_x207` | `id` bigint identity, `account_id` text null, `page` text (1 to 200), `message` text (1 to 2000), `ip_hash` text, `created_at` |
| `nonces_x207` | `nonce` text pk, `account_id`, `created_at` (rows older than an hour are deleted by the function) |

RLS is ON in all five and there is no policy, so `anon` and `authenticated` read and write nothing; their privileges are revoked too. Only `service_role` (the Edge Function) has access. `onboarding_x207` has no foreign key to `profiles_x207`: a user may tick the first steps before choosing a name. `ip_hash` is the sha256 of a salt and the address, kept only to count feedback per address.

## Deploy

1. Apply `migrations/20261109000000_x207_account_tables.sql` to the project (`apply_migration`, or `supabase db push`).
2. Deploy the function `x207-account` from `functions/x207-account/` (entry `index.ts`, the other two files next to it). Deploy it with `verify_jwt` off: the caller proves who they are with the NEP-413 signature, and a browser would otherwise need the anon key in every call. (With `verify_jwt` on, send `Authorization: Bearer <anon key>`; nothing else changes.)
3. Environment: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set by the platform. Optional: `X207_RPC_URL` (default `https://rpc.testnet.fastnear.com`), `X207_IP_SALT` (salt of the address hash; default is the project URL, so set one for a real secret). The service role key is never in this repository and never in a browser.

URL: `https://<project-ref>.supabase.co/functions/v1/x207-account`. CORS answers only `https://x207.vercel.app` and `http://localhost:5207`.

## API for the dashboard (Worker D)

One endpoint, `POST`, JSON body (at most 16 KiB). Every account action carries a NEP-413 signature.

```json
{
  "action": "get | upsert_profile | upsert_onboarding | upsert_prefs | feedback",
  "data": { },
  "accountId": "alice.testnet",
  "publicKey": "ed25519:...",
  "signature": "<base64 or ed25519:base58>",
  "message": "x207:<action>",
  "nonce": "<base64 of 32 bytes>",
  "recipient": "x207.vercel.app"
}
```

### How to sign

Call the wallet's `signMessage` (NEP-413) with:

- `message`: exactly `x207:` + the action, for example `x207:upsert_profile`. A signature made for one action is refused for another.
- `recipient`: `x207.vercel.app`.
- `nonce`: 32 bytes. The first 8 bytes are the current time in milliseconds, big endian (a `DataView.setBigUint64(0, BigInt(Date.now()), false)`); the other 24 are random. The server refuses a nonce older than 5 minutes or more than 1 minute in the future, and a nonce it has already seen. Use a new nonce for every request. Send it as base64.
- `callbackUrl`: none.

Send back the `accountId`, `publicKey` and `signature` that the wallet returns. The signed hash is `sha256(borsh(u32 2147484061) ++ borsh({message, nonce, recipient, callbackUrl: None}))`; the function checks the ed25519 signature on it, then asks the testnet RPC whether `publicKey` is a **full access key** of `accountId` (a function-call key is refused). An implicit account (64 hex) that does not exist yet is accepted when `publicKey` is the key whose hex is the account id. Only the signed account is read or written: there is no field that names another account.

### Actions

| action | `data` | answer |
| --- | --- | --- |
| `get` | none (omit or `{}`) | `200 {account_id, profile, onboarding, prefs}`; each of the three is the row or `null` |
| `upsert_profile` | `{ "display_name": "1 to 40 characters, trimmed" }` | `200`, same body as `get` |
| `upsert_onboarding` | any of `wallet_created`, `funds_received`, `joined`, `staked`, `tour_done` (booleans); other steps keep their value | `200`, same body as `get` |
| `upsert_prefs` | `{ "email"?: "a@b.c" or null, "deadline_reminder"?: boolean }` | `200`, same body as `get` |
| `feedback` | `{ "page": "1 to 200", "message": "1 to 2000" }`; the six signature fields are optional (all or none) | `201 {ok: true, signed: boolean}`; signed feedback keeps the account id |

`get` needs `data` to be an object only for the upserts; send `{}` for `get` if the client library insists on a body field.

Feedback is limited to 5 per hour per address (hash of the address as the function sees it). Signed requests are not limited by address but a nonce can be used once.

### Errors

`{"error": {"code", "message"}}`.

| status | code | meaning |
| --- | --- | --- |
| 400 | `invalid_request` | bad body, unknown action or field, a value out of range, signature fields missing or an account id that is not valid |
| 400 | `bad_public_key`, `bad_signature_format`, `bad_nonce` | the text cannot be read as a key, a signature (64 bytes) or a 32-byte nonce |
| 401 | `invalid_signature` | the signature does not match the payload |
| 401 | `wrong_recipient`, `wrong_message` | recipient is not `x207.vercel.app`, or `message` is not `x207:<action>` |
| 401 | `nonce_expired`, `nonce_used` | nonce older than 5 minutes (or too far ahead), or already spent: sign again with a new nonce |
| 403 | `key_not_owned` | the key is not a full access key of that account |
| 413 | `payload_too_large` | body over 16 KiB |
| 429 | `rate_limited` | too many feedback messages from this address |
| 503 | `rpc_unavailable` | the NEAR RPC did not answer; nothing was spent (the nonce is only spent after the key check) |
| 500 | `internal_error` | the function failed; see its logs |

A request refused for bad data (`invalid_request`) does not spend the nonce.

## What is checked and what is not

- The NEP-413 preimage layout is pinned by a test (TC-BE-116-01) and the signing in the tests is done with Node's ed25519 over the same hash. They were **not** compared with a signature made by a real wallet: that is the first thing to try once the dashboard signs (the usual cause of a mismatch is the nonce length or `callbackUrl`).
- The function itself has not been run on Deno here (no Deno on this machine); the logic is tested in Node, and `index.ts` (the Supabase client calls, CORS, the Deno globals) is not covered by a test.
- The RPC check follows testnet only. A mainnet account has another key set; pointing `X207_RPC_URL` at mainnet is possible but nothing here was tried on it.
