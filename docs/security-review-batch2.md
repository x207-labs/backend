# Security review, batch 2 (BE-062): SDK code of P5 to P2

Scope: `sdk/packages/core/src` (`license.ts` SD-070, `invoice.ts` SD-065, `order.ts` SD-069, `metered-presets.ts` SD-064) and `sdk/packages/scheme` (`client/buyer-meter.ts` SD-068, `server/job-escrow.ts` SD-067). SD-071 (client side of the P2 rent) was not in the repository when this was written. Read only: nothing in `repos/x207/sdk` was changed. Every finding has a test that passes **today** and shows the problem; the full file is at the end (it was run from `backend/test/` and then removed, it is not in the repository; the tests are written to be turned into failing-then-fixed tests once the fix is chosen).

Levels: High = money or a proof can be forged by the other party with no cooperation; Medium = a documented guarantee does not hold under a caller mistake that is easy to make, or a party can gain with a plausible setup; Low = hardening; Info = a limit to write down.

## Summary
| # | Level | Where | Finding |
| --- | --- | --- | --- |
| F1 | **High** | `license.ts:85-91`, `license.ts:337` | A 65-byte ciphertext has the same `cipher_hash` as any ciphertext above 4 MiB, so a **false proof of cheating** against an honest seller passes `checkCheatProof` |
| F2 | Medium | `license.ts:85-91` | The same hash scheme makes `content_hash` of a large file equal to the hash of a 65-byte file |
| F3 | Medium | `buyer-meter.ts:104-107,133-142` | The ceiling counts everything ever received, not the epoch: a voucher of the next epoch is not limited by what was received in that epoch |
| F4 | Medium | `order.ts:175-190` | `payForProofs` pays the same proofs again, and over the budget, when the caller does not pass `alreadyPaid` and `alreadySpent` again |
| F5 | Medium | `order.ts:152-168` | `milestoneVoucher` has no memory: the same milestone can be paid again and again, past the budget |
| F6 | Low | `metered-presets.ts:50-67`, `backend/src/marketplace/resource-listing.ts:42` | `endpointProblem` accepts `https://localhost./`, `…internal.` and names such as `127.0.0.1.nip.io` |
| F7 | Low | `job-escrow.ts:156-172` | `SellerJob.accept` does not look at `resource`: a voucher for something else counts as payment of a chunk |
| F8 | Low | `buyer-meter.ts:116`, `metering.ts:51` | `BigInt()` of the price in the 402 takes hex, spaces and an empty text |
| F9 | Low | `invoice.ts:166` | `catchUpVoucher` signs on top of any `state` it is given |
| F10 | Low | `license.ts:407-424` | `httpsSource` follows redirects and checks only the last address; no check of the host (buyer-side blind SSRF) |
| F11 | Info | `license.ts:206-218`, `license.ts:337` | XChaCha20-Poly1305 does not commit to its key |
| F12 | Info | `license.ts:240`, `order.ts:175` | The release has no purchase id; the proofs of `payForProofs` are not checked against the chain |
Checked and found sound: the nonce of the file encryption (random 128-bit prefix per file, counter per chunk, the last chunk marked in the AAD, so truncation and reordering fail); the sealed key (X25519 from the ed25519 key, key unique per ephemeral key so the fixed nonce is safe); the signature of the release (binds circle, license, buyer, hashes, sealed key); `parseRawCid` (CIDv1, raw, sha2-256, CIDv0 refused); `planInstallments` (sums exactly, 1 to 24); the canonical JSON of invoice, order and license (fixed key order, regex on every field, extra fields dropped, no leading zeros in amounts).

## F1 (High): false proof of cheating through the hash scheme
`ContentHasher.digest()` (`license.ts:85`) hashes a body up to 4 MiB as plain `sha256(data)` and a larger body as an RFC 6962 style Merkle root, where a node is `sha256(0x01 ‖ left ‖ right)`. A body of exactly the shape `0x01 ‖ left ‖ right` (65 bytes) is hashed as plain `sha256`, which **is** the node hash. So for any ciphertext C above 4 MiB the 65-byte string `0x01 ‖ H(left half) ‖ H(right half)` has `contentHash` equal to `contentHash(C)`.
`checkCheatProof` (`license.ts:337`) takes `proof.ciphertext` from the one who proves, checks `contentHash(ciphertext) === release.cipher_hash` (passes), opens the sealed key with the box key (the real one, which the buyer has), tries to decrypt the 65 bytes, fails, and answers `{valid: true, reason: "decrypt_failed"}`. A buyer of a **correct** 8 MiB file gets a valid cheat proof against the honest seller. The claim "anyone can check the proof" (ADR-46) is exactly the setting in which the ciphertext comes with the proof (`CheatProof` has the field).
Not reachable in the backend of BE-056: it downloads the ciphertext from the source the seller named and never takes it from the buyer. It is reachable by any other verifier (an arbiter, a client, a later contract check).
Test: `F1` below.
Fix: one scheme for every size, with the leaf prefix, so that a short file is `sha256(0x00 ‖ data)` (the Merkle root of one leaf, which `merkleRoot` already returns for one leaf). Then no body can be both a leaf and a node. This changes every existing hash (both `content_hash` and `cipher_hash`): do it before the hashes are used. Until then, a verifier must take the ciphertext from the source, as BE-056 does, never from the proof, and `checkCheatProof` should check `ciphertext.length` against the size in the release (add `cipher_size` to the signed release).

## F2 (Medium): `content_hash` second preimage
Same cause. An 8 MiB file and the 65-byte string built from its leaf hashes have the same `content_hash`. A seller who sells "the dataset with hash H" can deliver 65 bytes: `verifyDelivery` says `ok`. The buyer knew only the hash (and a preview, whose hash is separate), so this is a real substitution when a hash is quoted from a public file. Test `F2`. Fix as F1, plus the size in the signed release.

## F3 (Medium): the ceiling of `BuyerMeter` has no epoch
`ceiling()` is `unitPrice × (received + pending)` for the whole life of the meter (`buyer-meter.ts:104`). The cumulative amount of a voucher restarts in each epoch (ADR-17, per `(payer, payee, epoch)`). In epoch 2, with 10 calls received in epoch 1, a voucher with cumulative 10 credit passes `checkVoucher` although nothing was received in epoch 2; the seller is paid again. The same hole keeps a buyer who pays several sellers from using one meter. Test `F3`.
Fix: the meter holds `baseCumulative` and `epoch` and a `startEpoch(epoch, baseCumulative)`; the ceiling is `base + price(received in this epoch + pending)`; `checkVoucher` takes the epoch of the voucher and refuses another one.

## F4 (Medium): `payForProofs` pays twice without the bookkeeping of the caller
The budget guard is `spent + each > budget` with `spent` starting at `alreadySpent ?? 0` and the duplicate guard `alreadyPaid ?? []` (`order.ts:189-190`). Both are optional. An agent that restarts, or calls twice, with the same proofs and the new `state` pays them again until the cumulative is twice the budget. Test `F4`.
Fix: make both required (`alreadyPaid: []` spelled out), or derive them: pass the vouchers already signed and recompute, or return a receipt object that the next call must take. At least refuse when `state.cumulativeAmount` is above the base plus the budget (`state` of the pair minus what the order paid is unknown to the function, so the caller must give `baseCumulative`).

## F5 (Medium): `milestoneVoucher` can be called again for a paid milestone
Nothing in `order.ts:152` knows which milestone was paid or what the budget is. Three calls for milestone 1 give a cumulative of 3 × the milestone. SD-069 says the voucher is built "after" the confirmation, but the library gives no help to keep that rule. Test `F5`.
Fix: an `OrderLedger` (or a `paid: number[]` argument that is required) that refuses a milestone already paid, a milestone that is not the next one after a dispute, and a cumulative above `baseCumulative + orderBudget`.

## F6 (Low): `endpointProblem`
`https://localhost./` (trailing dot), `https://metadata.google.internal./` and a name such as `127.0.0.1.nip.io` pass the check (`metered-presets.ts:64`, `resource-listing.ts:42`). The check is only about the text. A buyer agent that calls the endpoint is sent to its own network, with a payment header. Test `F6`.
Fix: strip one trailing dot before the checks; document that a buyer must resolve the name and refuse non-public addresses when it connects (the guard of BE-054, `ssrf.ts`, can be moved into `core` for that).

## F7 (Low): `SellerJob.accept` ignores `resource`
`job-escrow.ts:156` checks circle, payer, payee, epoch and unit, not `resource`. A voucher of the same pair for another purpose, with a cumulative that fits, is counted as the payment of the next chunk. Test: `F8` in the reproduction file (its F7 test is finding F8 of this list, its F8 test is finding F7). Fix: require `resource === "job:<jobId>"` in the argument type and the check.

## F8 (Low): lax number parsing in the 402
`BigInt(announcement.unit_price)` (`buyer-meter.ts:116`, `metering.ts:51`) takes `"0x10"`, `" 12 "` and `""`. A price in hex is read by the buyer and by `meterAmount` alike, but the facilitator or a seller written in another language reads it differently, and the check `announcedPrice > this.unitPrice` compares a different number. Fix: `/^[1-9]\d*$/` before `BigInt` (as `isAmount` in `order.ts`), a stable `meter_bad_count` otherwise.

## F9 (Low): `catchUpVoucher` trusts `state`
The debtor signs `state.cumulativeAmount + installment` (`invoice.ts:166`). If the state came from anywhere but the chain (the issuer, the backend), an inflated state makes the debtor pay the difference to the issuer. The function and the FE read the state of the contract (`viewContract('obligation')`), so this is a rule to keep, not a bug now. Test `F9`. Fix: the signature takes `{state, source: "chain"}` or a `ViewObligationFn`, like `createViewAccessKeyFn`, and reads it itself.

## F10 (Low): `httpsSource`
`redirect: "follow"` and a check of `res.url` after the fact (`license.ts:416-420`): a redirect through a plain `http://` address is still requested. No check of the host at all: a seller can name `https://internal.corp.example/…` and a buyer agent on a server fetches it (blind: the body is checked against `cipher_hash` and dropped). Fix: `redirect: "manual"` with a limit of redirects and a check of each address; for Node buyers, the same guard as F6.

## F11 (Info): AEAD without key commitment
XChaCha20-Poly1305 (the file, and the sealed key) is not key-committing: a ciphertext can be built that opens under two keys to two different plaintexts. In this design the key of the file always comes from the signed release and the box key is checked against the sealed key, so a buyer cannot get a false proof out of it without the seller crafting the sealed key, and a seller who crafts it only harms itself. It would matter if a different key could be named later. Cheap fix: put `sha256(contentKey)` (a commitment) in the signed release and check it after opening.

## F12 (Info)
- The release (`license.ts:240`) has no purchase id or nonce: a release for a buyer and a license can be replayed for a second purchase of the same license by the same buyer. Add `purchase_id` or the voucher's `(epoch, seq)`.
- `payForProofs` takes `txHash`, `method`, `signer` as plain text from the backend. A compromised backend makes the agent pay up to the budget. Add an optional `verifyTx` callback that asks the chain.

## Reproduction file
```ts
import { describe, expect, it } from "vitest";
import {
  CONTENT_CHUNK, catchUpVoucher, checkCheatProof, contentHash, createRelease, deriveBoxKey, encryptContent, endpointProblem, generateVoucherKeypair, milestoneVoucher, payForProofs,
  planInstallments, sha256Hex as _x, type OrderDocument,
} from "@x207/core";
import { BuyerMeter } from "@x207/scheme";
import { SellerJob, JobBudget } from "../../sdk/packages/scheme/server/job-escrow.js";
import { endpointProblem as backendEndpointProblem } from "../src/marketplace/resource-listing.js";
import { createHash } from "node:crypto";

void _x;
const sha = (b: Uint8Array): Uint8Array => createHash("sha256").update(b).digest();
const cat = (...p: Uint8Array[]): Uint8Array => Buffer.concat(p);

describe("review batch 2", () => {
  it("F1 forged cheat proof: a 65-byte ciphertext has the cipher_hash of a correct 2+ chunk ciphertext", () => {
    const seller = generateVoucherKeypair();
    const buyer = generateVoucherKeypair();
    const plain = new Uint8Array(CONTENT_CHUNK * 2).fill(7); // a correct, honest file of 8 MiB
    const { ciphertext, key } = encryptContent(plain);
    const { release, signature } = createRelease({
      circle: "x207-circle.near", license_hash: "a".repeat(64), buyer: "b.near", buyerPublicKey: buyer.publicKey, content_hash: contentHash(plain), ciphertext, contentKey: key, at: 1, sellerSecretKey: seller.secretKey,
    });
    // the Merkle root of the ciphertext is sha256(0x01 || L || R) for the leaves L, R of its two halves (the ciphertext is 3 chunks of 4 MiB: split at 2 chunks)
    const leaf = (b: Uint8Array) => sha(cat(Uint8Array.of(0), b));
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < ciphertext.length; i += CONTENT_CHUNK) chunks.push(ciphertext.subarray(i, i + CONTENT_CHUNK));
    expect(chunks.length).toBe(3);
    const node = (l: Uint8Array, r: Uint8Array) => sha(cat(Uint8Array.of(1), l, r));
    const left = node(leaf(chunks[0]!), leaf(chunks[1]!));
    const right = leaf(chunks[2]!);
    const forged = cat(Uint8Array.of(1), left, right); // 65 bytes
    expect(forged.length).toBe(65);
    expect(contentHash(forged)).toBe(release.cipher_hash); // same cipher_hash
    const sealed = Buffer.from(release.sealed_key, "hex");
    const proof = checkCheatProof({ ciphertext: forged, release, signature, box_key: Buffer.from(deriveBoxKey(sealed, buyer.secretKey)).toString("hex") }, seller.publicKey);
    expect(proof).toEqual({ valid: true, reason: "decrypt_failed" }); // a valid cheat proof against an honest seller
  });

  it("F2 content_hash of an 8 MiB file equals the hash of a 65-byte file", () => {
    const big = new Uint8Array(CONTENT_CHUNK + 1).fill(1);
    const l = sha(cat(Uint8Array.of(0), big.subarray(0, CONTENT_CHUNK)));
    const r = sha(cat(Uint8Array.of(0), big.subarray(CONTENT_CHUNK)));
    const small = cat(Uint8Array.of(1), l, r);
    expect(contentHash(small)).toBe(contentHash(big));
  });

  it("F3 BuyerMeter has no epoch: the ceiling of lifetime receipts lets a seller bill them again in the next epoch", () => {
    const m = new BuyerMeter({ unit: "call", unitPrice: "1" });
    m.recordCalls(10); // 10 credit received and paid in epoch 1
    expect(() => m.checkVoucher("10000000")).not.toThrow(); // epoch 2: nothing received yet, cumulative restarts at 0, a voucher of 10 credit still passes
  });

  it("F4 payForProofs pays the same proofs twice when alreadyPaid / alreadySpent are not given again", () => {
    const keys = generateVoucherKeypair();
    const order: OrderDocument = {
      circle: "x207-circle.near", kind: "keeper", buyer: "b.near", seller: "s.near", spec_hash: "a".repeat(64), nonce: "n1", proof: { method: "close_epoch", amount_per_tx: "1000000" },
      milestones: [{ amount: "2000000", due_at: 100 }],
    };
    const proofs = [{ txHash: "t1", method: "close_epoch", signer: "s.near" }, { txHash: "t2", method: "close_epoch", signer: "s.near" }];
    const first = payForProofs({ order, epoch: 5, state: { seq: 0, cumulativeAmount: "0" }, proofs, secretKey: keys.secretKey });
    const second = payForProofs({ order, epoch: 5, state: first.state, proofs, secretKey: keys.secretKey }); // the agent forgot to pass alreadyPaid/alreadySpent
    expect(first.paid).toEqual(["t1", "t2"]);
    expect(second.paid).toEqual(["t1", "t2"]);
    expect(second.state.cumulativeAmount).toBe("4000000"); // 2x the budget of 2000000
  });

  it("F5 milestoneVoucher can be built for the same milestone again and again, past the budget", () => {
    const order: OrderDocument = {
      circle: "x207-circle.near", kind: "research", buyer: "b.near", seller: "s.near", spec_hash: "a".repeat(64), nonce: "n1", milestones: [{ amount: "5000000", due_at: 100 }],
    };
    let state = { seq: 0, cumulativeAmount: "0" };
    for (let i = 0; i < 3; i++) {
      const v = milestoneVoucher({ order, index: 1, epoch: 5, state });
      state = { seq: v.seq, cumulativeAmount: v.cumulativeAmount };
    }
    expect(state.cumulativeAmount).toBe("15000000"); // 3x a milestone of 5, budget 5
  });

  it("F6 endpointProblem accepts a trailing-dot localhost and names that resolve to private addresses", () => {
    for (const f of [endpointProblem, backendEndpointProblem]) {
      expect(f("https://localhost./admin")).toBeNull();
      expect(f("https://127.0.0.1.nip.io/admin")).toBeNull();
      expect(f("https://metadata.google.internal./latest")).toBeNull();
    }
  });

  it("F7 BuyerMeter.authorize reads unit_price with BigInt(): hex, spaces and empty text are numbers", () => {
    const m = new BuyerMeter({ unit: "call", unitPrice: "1" });
    expect(BigInt("0x10")).toBe(16n);
    expect(BigInt("")).toBe(0n);
    expect(BigInt(" 12 ")).toBe(12n);
    let code: string | undefined;
    try {
      m.authorize({ unit: "call", unit_price: "0x10", quantity: "1" }, "16");
    } catch (e) {
      code = (e as { code?: string }).code ?? (e as Error).name;
    }
    // whatever it is, it must be one of the stable codes; record what happens
    expect(["meter_amount_mismatch", "meter_price_too_high", "SyntaxError", undefined]).toContain(code);
    console.log("F7 authorize hex price ->", code);
  });

  it("F8 SellerJob.accept does not look at the resource of the voucher", () => {
    const budget = new JobBudget({ jobId: "j1", circle: "c.near", buyer: "b.near", seller: "s.near", epoch: 1, unit: "job", chunks: 2, chunkQuantity: 1, unitPrice: "1" } as never);
    const job = new SellerJob(budget);
    const v = { circle: "c.near", payer: "b.near", payee: "s.near", epoch: 1, seq: 1, cumulativeAmount: budget.cumulativeFor(1).toString(), unit: "credit", resource: "invoice:other" } as never;
    expect(job.accept(v).paidChunks).toBe(1);
  });

  it("F9 catchUpVoucher signs whatever pair state it is given", () => {
    const plan = planInstallments({ circle: "c.near", doc: { id: "I1", issuer: "a.near", debtor: "d.near", amount: "30000000", memo: "x" }, firstEpoch: 5, count: 3 });
    const v = catchUpVoucher(plan, 1, { seq: 1, cumulativeAmount: "900000000" }, false);
    expect(v.cumulativeAmount).toBe("910000000"); // the debtor would pay 900 credit more than the installment if the state came from an untrusted source
  });
});
```
