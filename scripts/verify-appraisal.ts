// BE-119: re-check one x207 appraisal without trusting x207. Self-contained: Node 22.6+ (type stripping) and two audited libraries
// (@noble/curves, @noble/hashes); nothing from the x207 code base.
//
//   node scripts/verify-appraisal.ts <url of the appraisal | path to its JSON> [--quote-check] [--no-attestation]
//
// What it checks, each printed as PASS / FAIL / SKIP:
//   1. sha256 of the stored request and response bytes equals the stored hashes;
//   2. the request is the appraiser's: same model, temperature 0, and the system prompt hashes to the stored rubric hash;
//   3. the response is the chat named by chat_id, and its JSON answer is the stored result;
//   4. the signed text is `model:sha256(request):sha256(response)` and the signature recovers (secp256k1, EIP-191) to signing_address;
//   5. a FRESH attestation report of NEAR AI Cloud (your own random nonce) names signing_address, echoes your nonce, and the TDX quote
//      carries signing_address || 12 zero bytes || nonce in report_data;
//   6. with --quote-check: the TDX quote is sent to the Phala verifier and the GPU evidence to NVIDIA NRAS (services of other parties).
//   Optional: with NEARAI_API_KEY in the env, the signature is fetched again from NEAR AI Cloud and compared (the key is never printed).
// It does NOT run Intel DCAP locally and does not check the signature of the NRAS token. Step 5 fails when the TEE instance that signed
// the chat has since restarted with a new key: the stored attestation summary (fetched at appraisal time) is then the only record.
// Exit code 0 when no check failed.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const CLOUD = process.env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1";
const PHALA = "https://cloud-api.phala.network/api/v1/attestations/verify";
const NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const quoteCheck = args.includes("--quote-check");
const noAttestation = args.includes("--no-attestation");
if (!target) {
  console.error("usage: node scripts/verify-appraisal.ts <appraisal url | file.json> [--quote-check] [--no-attestation]");
  process.exit(2);
}

let failed = 0;
const report = (state: "PASS" | "FAIL" | "SKIP", name: string, detail = "") => {
  if (state === "FAIL") failed += 1;
  console.log(`${state}  ${name}${detail ? ` - ${detail}` : ""}`);
};
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));

function recover(text: string, sigHex: string): string | null {
  try {
    const sig = hexBytes(sigHex);
    if (sig.length !== 65) return null;
    const msg = new TextEncoder().encode(text);
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
    const digest = keccak_256(new Uint8Array([...prefix, ...msg]));
    let v = sig[64]!;
    if (v >= 27) v -= 27;
    const pub = secp256k1.recoverPublicKey(new Uint8Array([v, ...sig.subarray(0, 64)]), digest, { prehash: false });
    const full = secp256k1.Point.fromBytes(pub).toBytes(false);
    return `0x${Buffer.from(keccak_256(full.subarray(1)).subarray(12)).toString("hex")}`;
  } catch {
    return null;
  }
}

const reportData = (quoteHex: string): string | null => {
  const q = Buffer.from(quoteHex.replace(/^0x/, ""), "hex");
  return q.length >= 48 + 520 + 64 ? q.subarray(568, 632).toString("hex") : null;
};

async function load(t: string): Promise<any> {
  if (/^https?:\/\//.test(t)) {
    const res = await fetch(t);
    if (!res.ok) throw new Error(`GET ${t} answered HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(readFileSync(t, "utf8"));
}

const a = await load(target);
const ev = a.evidence ?? {};
const model: string = a.model;
console.log(`appraisal ${a.appraisal_id}  model ${model}  chat ${ev.chat_id}`);
console.log(`result: ${a.result?.value_credits} credits (range ${a.result?.range?.low}..${a.result?.range?.high}, confidence ${a.result?.confidence}, flags ${(a.result?.flags ?? []).join(",") || "none"})`);
console.log(`x207 said: signature ${a.verified?.signature}, attestation ${a.verified?.attestation}`);
console.log("");

// 1. hashes of the stored bytes
const reqHash = typeof ev.request_body === "string" ? sha256(ev.request_body) : null;
const resHash = typeof ev.response_body === "string" ? sha256(ev.response_body) : null;
report(reqHash !== null && reqHash === ev.request_hash ? "PASS" : "FAIL", "request bytes hash to request_hash", reqHash ?? "no request body");
report(resHash !== null && resHash === ev.response_hash ? "PASS" : "FAIL", "response bytes hash to response_hash", resHash ?? "no response body");

// 2. the request: model, temperature 0, rubric
try {
  const req = JSON.parse(ev.request_body);
  report(req.model === model && req.temperature === 0 ? "PASS" : "FAIL", "request uses the stated model at temperature 0", `${req.model}, temperature ${req.temperature}`);
  const system: string = req.messages?.[0]?.role === "system" ? req.messages[0].content : "";
  const flagsLine = system.split("\n").find((l) => l.startsWith("Allowed flags: ")) ?? "";
  const flags = flagsLine.replace(/^Allowed flags: /, "").replace(/\.$/, "").split(", ").join(",");
  const rubricHash = sha256([a.rubric?.version, system, flags].join("\n"));
  report(rubricHash === a.rubric?.hash ? "PASS" : "FAIL", "system prompt sent hashes to rubric.hash", `${a.rubric?.version} ${rubricHash.slice(0, 16)}...`);
} catch {
  report("FAIL", "request body is JSON");
}

// 3. the response: chat id and the answer
try {
  const res = JSON.parse(ev.response_body);
  report(res.id === ev.chat_id ? "PASS" : "FAIL", "response is chat_id", res.id);
  const content = String(res.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const answer = JSON.parse(content);
  const same = Math.abs(Number(answer.value_credits) - Number(a.result?.value_credits)) < 1e-6;
  report(same ? "PASS" : "FAIL", "model answer in the response equals the stored value", `${answer.value_credits}`);
} catch {
  report("FAIL", "response body holds a JSON answer");
}

// 4. the TEE signature
const expectedText = `${model}:${ev.request_hash}:${ev.response_hash}`;
report(ev.signed_text === expectedText ? "PASS" : "FAIL", "signed text is model:request_hash:response_hash");
const signer = typeof ev.signature === "string" ? recover(ev.signed_text ?? "", ev.signature) : null;
report(signer !== null && signer === String(ev.signing_address).toLowerCase() ? "PASS" : "FAIL", "signature recovers to signing_address (secp256k1, EIP-191)", signer ?? "no signature");

if (process.env.NEARAI_API_KEY && ev.chat_id) {
  try {
    const res = await fetch(`${CLOUD}/signature/${encodeURIComponent(ev.chat_id)}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${process.env.NEARAI_API_KEY}` } });
    const s = res.ok ? ((await res.json()) as { text?: string; signature?: string }) : null;
    report(s?.text === ev.signed_text && s?.signature === ev.signature ? "PASS" : "FAIL", "NEAR AI Cloud returns the same signature for chat_id today", res.ok ? "" : `HTTP ${res.status}`);
  } catch (err) {
    report("FAIL", "NEAR AI Cloud returns the same signature for chat_id today", err instanceof Error ? err.message : "");
  }
} else {
  report("SKIP", "fetch the signature again from NEAR AI Cloud", "set NEARAI_API_KEY to do it");
}

// 5. a fresh attestation report, with our own nonce
if (noAttestation) {
  report("SKIP", "fresh attestation report", "--no-attestation");
} else {
  const want = String(ev.signing_address).toLowerCase();
  let entry: any = null;
  let nonce = "";
  let attempts = 0;
  for (; attempts < 8 && !entry; attempts++) {
    nonce = randomBytes(32).toString("hex");
    const res = await fetch(`${CLOUD}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa&nonce=${nonce}`);
    if (!res.ok) continue;
    const r = (await res.json()) as { model_attestations?: any[] };
    entry = (r.model_attestations ?? []).find((m) => String(m.signing_address ?? "").toLowerCase() === want) ?? null;
  }
  if (!entry) {
    report("FAIL", "fresh attestation report names signing_address", `not in ${attempts} reports; the instance may have restarted with a new key`);
  } else {
    report("PASS", "fresh attestation report names signing_address", `after ${attempts} report(s)`);
    report(String(entry.request_nonce).toLowerCase() === nonce ? "PASS" : "FAIL", "report echoes our fresh nonce");
    const rd = entry.intel_quote ? reportData(entry.intel_quote) : null;
    report(rd === want.replace(/^0x/, "") + "0".repeat(24) + nonce ? "PASS" : "FAIL", "TDX report_data = signing_address || 0x00*12 || nonce");
    if (a.attestation?.compose_hash && entry.info?.compose_hash) {
      report(entry.info.compose_hash === a.attestation.compose_hash ? "PASS" : "FAIL", "compose_hash today equals compose_hash at appraisal time", entry.info.compose_hash);
    }
    // 6. third-party checks of the quote and the GPU evidence
    if (!quoteCheck) {
      report("SKIP", "TDX quote and GPU evidence by third parties", "add --quote-check");
    } else {
      try {
        const p = await fetch(PHALA, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hex: entry.intel_quote }) });
        const body = (await p.json()) as { quote?: { verified?: boolean; body?: { reportdata?: string } } };
        const pr = String(body.quote?.body?.reportdata ?? "").replace(/^0x/, "").toLowerCase();
        report(body.quote?.verified === true && pr === rd ? "PASS" : "FAIL", "Phala verifier: TDX quote verified, same report_data", new URL(PHALA).host);
      } catch (err) {
        report("FAIL", "Phala verifier reachable", err instanceof Error ? err.message : "");
      }
      try {
        const sent = JSON.parse(entry.nvidia_payload) as { nonce?: string };
        const n = await fetch(NRAS, { method: "POST", headers: { "content-type": "application/json" }, body: entry.nvidia_payload });
        const body = (await n.json()) as unknown;
        const jwt = Array.isArray(body) && Array.isArray(body[0]) && body[0][0] === "JWT" ? String(body[0][1]) : "";
        const claims = jwt ? JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) : {};
        const ok = String(sent.nonce).toLowerCase() === nonce && claims["x-nvidia-overall-att-result"] === true;
        report(ok ? "PASS" : "FAIL", "NVIDIA NRAS: GPU evidence for our nonce, overall result true (token signature not checked)", new URL(NRAS).host);
      } catch (err) {
        report("FAIL", "NVIDIA NRAS reachable", err instanceof Error ? err.message : "");
      }
    }
  }
}

console.log("");
console.log(failed === 0 ? "no check failed" : `${failed} check(s) failed`);
console.log("Reminder: an appraisal is advice; the parties still agree on the price, and the x207 circle contract does not read it.");
process.exit(failed === 0 ? 0 : 1);
