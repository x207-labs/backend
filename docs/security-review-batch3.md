# Security review, batch 3 (BE-063): frontend and agents, P5 to P2

Scope: `frontend/src/pages/{Invoices,Orders,Licenses,Rent}.tsx` with `src/lib/{invoiceFlow,orderFlow,licenseFlow,barter}.ts` (FE-024 to FE-028), `frontend/index.html`, and in `agents/`: `shared/identity.ts`, `shared/nearai.ts`, `shared/agent-server.ts`, `onboarding/run.ts`, `scenario/{metered,invoices,invoice-book,license}.ts` (AG-024, AG-025, and the license scenario that exists). AG-026 to AG-028 and the parts of the frontend that do not exist yet were skipped. Read only: nothing in `frontend/` or `agents/` was changed. The earlier review `frontend/docs/security-review.md` (FE-1 and FE-2) is the base: this one looks at what the new pages add.

The attacker is the one of that review: **the read API or the backend** (it can answer anything), another member, or anyone who can put text in a listing, a memo or a preview. Levels as in batch 2.

## Summary
| # | Level | Where | Finding |
| --- | --- | --- | --- |
| F1 | **High** | `Licenses.tsx:256-285` | The buyer signs a voucher to the payee and for the price that the API gives; the signature of the listing is never checked |
| F2 | **High** | `Licenses.tsx:124-131` | The seller seals the key of the file to the public key that the API names as the buyer |
| F3 | Medium | `Orders.tsx:123-131`, `Licenses.tsx:198`, `invoiceFlow.ts:41` | Notices and vouchers name an order, purchase or invoice by what the API says; the page does not tie it to what the user chose or saw |
| F4 | Medium | `index.html:8` | The policy has no `script-src` and no `connect-src`: one injected script reads the voucher key |
| F5 | Low | `VoucherKeyField.tsx`, all pages | The key stays in the state of the page until the tab is closed, one field for every action |
| F6 | Low | `licenseFlow.ts:31`, `license.ts:407` (sdk) | The browser fetches the address that the seller wrote, following redirects: the seller learns the IP of the buyer |
| F7 | Low | `Rent.tsx:77-84` | `checkAccessBeforeNextDay` believes the `paidUntil` that the broker itself reports |
| F8 | Low | `agents/shared/identity.ts:51-56` | The key file is read without looking at its mode or owner |
| F9 | Info | `Licenses.tsx` | The key of the file lives only in the page of the seller |
Checked and sound: no HTML sink in any page (`dangerouslySetInnerHTML`, `innerHTML`, `eval`, `document.write`: none), memo, preview, terms, source, reason and detail are shown as text; the only `<a href>` have a fixed prefix; every notice and bundle is signed with the **recipient `CONTRACT_ID` from the configuration**, not from the API (the FE-1 class is not repeated: `invoiceFlow.ts:15`, `orderFlow.ts:105`, `licenseFlow.ts:86`, `Rent.tsx:95`); `localStorage` holds only the flag of the wallet; the voucher key is in a `type="password"` field with `autocomplete="off"`, is not in any request body (tests assert it), URL or error text; the file that the buyer saves is a `Blob` with a fixed name and no type; `catch-up` reads the state of the pair from the contract (`Invoices.tsx:135`, which closes F9 of batch 2 on this side); agents print no key (`identity.ts` says so, `nearai.ts` logs agent, model, status and latency; `onboarding/run.ts` prints the account); `.keys/`, `.secrets/`, `.env` are ignored.

## F1 (High): the voucher goes where and for what the API says
`BuyForm.buy()` reads `api.listing(hash)` and builds the voucher from `listing.account` (payee) and `listing.offer.value` (amount), then signs it with the key of the buyer and sends it to the backend, which holds it and releases it to the payee when the purchase is confirmed. The listing comes with the signature of the seller, but nothing verifies it (the existing test even uses `signature: 'ed25519:x'`). A hostile API (or a backend that is hostile or hacked) makes the buyer pay any account any amount. The page does not show the payee or the price before the button signs. Same class as FE-1. Test `H1`: the voucher is signed to the attacker for 999 credit with a listing whose signature is not valid.
Fix: before signing, `verifyListingSignature(listing, signature, keyOfSeller)` with the key of the seller read from the contract (`get_member`), and compare `listingHash(listing)` to the hash the user typed; show payee, price and the `license_doc` and ask for a click on that text (the line of the button can carry it: "Buy 5 credit from seller.x207-circle.near"). The server-side check of the price already exists in the backend (it takes it from the stored listing), but the voucher is signed before.

## F2 (High): the key of the file goes to the key the API names
`Serve.releaseKey()` takes `buyer.pubkeyVoucher` from `api.member(view.buyer)` and seals the content key to it (`createRelease`). A hostile API gives its own key: the sealed key opens for the attacker, who can get the ciphertext (the purchase view names its source), and not for the real buyer (who sees `sealed_key_unopenable`, which is not provable). The seller's content is leaked and the sale fails. Test `H2` (the consequence, with the SDK): a key sealed to the attacker's key cannot be opened by the buyer, and can by the attacker.
Fix: read the key of the buyer from the contract, not the API (`get_member` view, as `obligation` already is); show its fingerprint; and take `view.buyer` from the voucher the seller saw in the held purchase, not from the answer.

## F3 (Medium): what is signed is named by the API, not by the user
- `Orders.tsx:123-131`: `milestoneNotice(CONTRACT_ID, view.orderHash, …)` signs a notice for `view.orderHash` while the page shows `view.order`. The page never computes `orderHashOf(view.order)` and compares (it only does so at creation). A hostile API shows the order the user knows and carries the hash of another order: the buyer **confirms** (and so pays) a milestone of the other order, the seller delivers a milestone that settles another.
- `Licenses.tsx:198`: the purchase notice is for `query.data.purchaseId` from the answer, not the id the user typed (`open`).
- `invoiceFlow.ts:41`: `buildApproval` checks the hash of the document against `view.invoiceHash`, both from the API: it proves nothing against a hostile API (the document shown is what the debtor signs, so the real protection is that the user reads it; the page shows issuer, debtor, amount, memo, but the button does not repeat them).
Fix: recompute the hash from the document in the view and refuse on a mismatch (`orders`: `orderHashOf`; purchases: compare to the id asked for), and put the amount and the other party on the button.

## F4 (Medium): no policy for scripts and connections
`index.html:8` is `object-src 'none'; base-uri 'none'; form-action 'self'`. The key of the voucher is in the DOM and in React state, so any script that runs in the page reads it and signs what it likes (test `H3` shows the policy). The code has no sink (see above), so this is about the unknown: a dependency, an extension, a later change. Fix: `script-src 'self'` (the dev server and the wallet may need `'wasm-unsafe-eval'` and the origin of the wallet), `connect-src` limited to the API, the RPC and the wallet hosts, `frame-ancestors 'none'` and `X-Content-Type-Options` as headers of the host (a `meta` element cannot carry `frame-ancestors`), and `require-trusted-types-for 'script'` once the bundle allows it.

## F5 (Low): lifetime of the key
`VoucherKeyField` keeps the key in the state of the parent for the life of the page; every action (sign a listing, a bundle, a rent stop, a takedown, release a license key) uses the same field. Nothing clears it after use or after a time. Fix: clear after a timeout of inactivity and after the actions that are not repeated (takedown, key release), or keep the key as a `CryptoKey` that cannot be exported (ed25519 in WebCrypto where it is available) so that a script can sign but not copy it.

## F6 (Low): the browser fetches the seller's address
`fetchCiphertext` runs in the browser of the buyer with `redirect: "follow"`. The seller chooses the address, so the seller sees the IP and the time of the buyer (a tracking pixel), and a redirect chain is followed. CORS stops the read of an internal address, not the request. Fix: show the host to the buyer before the download starts; for large files offer the download through a link opened by the user.

## F7 (Low): the check before the next day asks the broker
`checkAccessBeforeNextDay` gets `paidUntil` and `status` from `api.rent` (the broker). The broker is the party that can cut the access early (ADR-47 threat: "the grantor revokes early"); its answer that the access is alive is not evidence. Fix: the check also asks the provider (a call that needs the access: an authenticated read, an SSH banner) when the adapter allows it, or the lessee signs for one day at a time only after the delivery of the previous one (as `BuyerJob` does for chunks).

## F8 (Low): key file
`loadIdentity` (`identity.ts:51`) reads `<account>.agent.json` without checking that it is `0600` and owned by the user; `saveIdentity` makes the directory `0700` only when it creates it. A world-readable key file is used without a warning. The secret is in clear text in the file (documented). Fix: refuse a file with group or other bits (as `ssh` does), and `chmod` the directory.

## F9 (Info)
The key of the file and the plain bytes of the seller live only in the state of `Seller`; closing the tab loses the key, the seller cannot release it, and the held voucher is cancelled. Say so on the page and offer to download the key (encrypted).

## Reproduction file
The tests `H1`, `H2`, `H3` were run in `frontend/src/pages/` with the harness of the existing tests, all passing (they show the problem), and then removed. F3 and F4 to F9 are from reading the code; F3 has no executed test (it needs a page test with a mismatching hash, one more file in the same style as `H1`).
```tsx
import { readFileSync } from 'node:fs'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createRelease, encryptContent, generateVoucherKeypair, licensePublicKey, openSealedKey } from '@x207/core'
import { base58Encode } from '../lib/barter'
import { renderApp } from '../test/render'
import { createMockWallet } from '../test/walletMock'

const BUYER = 'buyer.x207-circle.near'
const SELLER = 'seller.x207-circle.near'
const ATTACKER = 'attacker.x207-circle.near'
const SEED = Uint8Array.from(new Array<number>(32).fill(5))
const KEY = `ed25519:${base58Encode(SEED)}`

describe('review batch 3', () => {
  it('H1 a hostile read API makes the buyer sign a voucher to another payee for another price (the listing signature is never checked)', async () => {
    const user = userEvent.setup()
    const docHash = 'd'.repeat(64)
    // the real listing is of SELLER for 5 credit; the API answers with ATTACKER, 999 credit and a signature that is not valid
    const listing = {
      listingHash: 'a'.repeat(64), account: ATTACKER, offer: { assetType: 'data:dataset', assetClass: 'D', quantity: 1, value: '999000000' }, want: { assetType: 'x', assetClass: 'D', quantity: 1, value: '1' },
      terms: '', detail: JSON.stringify({ kind: 'license', license_doc: docHash }), expiresAt: '2030-01-01T00:00:00Z', discountBps: 0, acceptPayment: true, discoverable: true, nonce: 'n', signature: 'ed25519:not-valid', status: 'open',
    }
    const { requests } = renderApp('/lisensi', (p, init) => {
      if (!init?.method && p.endsWith(`/listings/${'a'.repeat(64)}`)) return { status: 200, body: listing }
      if (init?.method === 'POST' && p.endsWith('/purchases')) return { status: 201, body: { purchase_id: 'p9' } }
      if (!init?.method && p.endsWith('/epochs')) return { status: 200, body: { items: [{ epoch: 42, phase: 'open', proposalDeadline: null }], nextCursor: null } }
      const rpc = init?.body ? (JSON.parse(String(init.body)) as { params?: { method_name?: string } }).params : undefined
      if (rpc?.method_name === 'obligation') return { status: 200, body: { jsonrpc: '2.0', id: 'x207', result: { result: Array.from(new TextEncoder().encode(JSON.stringify({ cumulative: '0', last_seq: 0 }))) } } }
      return undefined
    }, false, createMockWallet(BUYER, BUYER))
    const section = await screen.findByRole('region', { name: 'Pembelian lisensi' })
    await user.type(screen.getAllByLabelText(/Voucher key/)[0]!, KEY)
    await user.type(within(section).getByLabelText('Hash listing lisensi'), 'a'.repeat(64))
    await user.click(within(section).getByRole('button', { name: /Beli/ }))
    await waitFor(() => expect(requests().some((r) => r.method === 'POST' && r.path.endsWith('/purchases'))).toBe(true))
    const post = requests().find((r) => r.method === 'POST' && r.path.endsWith('/purchases'))!
    expect(post.body.voucher).toMatchObject({ payer: BUYER, payee: ATTACKER, cumulativeAmount: '999000000' }) // signed, with no question asked
  })

  it('H2 the key of the file is sealed to the public key that the API names as the buyer: the real buyer cannot open it, the owner of that key can', () => {
    const buyer = generateVoucherKeypair()
    const attacker = generateVoucherKeypair()
    const { ciphertext, key } = encryptContent(new TextEncoder().encode('the paid dataset'))
    // Licenses.tsx:126-129 takes buyerPublicKey from api.member(view.buyer).pubkeyVoucher; here the API lies
    const { release } = createRelease({ circle: 'c.near', license_hash: 'a'.repeat(64), buyer: 'buyer.near', buyerPublicKey: attacker.publicKey, content_hash: 'b'.repeat(64), ciphertext, contentKey: key, at: 1, sellerSecretKey: generateVoucherKeypair().secretKey })
    const sealed = Uint8Array.from(Buffer.from(release.sealed_key, 'hex'))
    expect(() => openSealedKey(sealed, buyer.secretKey)).toThrow()
    expect(Buffer.from(openSealedKey(sealed, attacker.secretKey)).equals(Buffer.from(key))).toBe(true)
    expect(licensePublicKey(attacker.secretKey)).toBe(attacker.publicKey)
  })

  it('H3 the policy of index.html does not limit scripts or connections', () => {
    const html = readFileSync(process.cwd() + '/index.html', 'utf8')
    const csp = /Content-Security-Policy" content="([^"]*)"/.exec(html)![1]!
    expect(csp).toBe("object-src 'none'; base-uri 'none'; form-action 'self'")
    expect(csp).not.toContain('script-src')
    expect(csp).not.toContain('connect-src')
    expect(csp).not.toContain('frame-ancestors') // not allowed in a meta element, needs a header
    void SELLER
  })
})
```
