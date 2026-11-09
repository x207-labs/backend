// BE-116: the logic of the Edge Function `x207-account`, with no Deno and no Supabase in it: the store, the RPC and the clock are given. `index.ts` wires the real ones, the tests wire fakes.
import { bytesToHex, verifyNep413, type SignedRequest, type VerifyError } from "./nep413.ts";

export const ONBOARDING_FLAGS = ["wallet_created", "funds_received", "joined", "staked", "tour_done"] as const;
export type OnboardingFlag = (typeof ONBOARDING_FLAGS)[number];
export const FEEDBACK_PER_IP_PER_HOUR = 5;

export interface Store {
  /** Records the nonce; `false` when it was recorded before. */
  useNonce(nonce: string, accountId: string, nowMs: number): Promise<boolean>;
  getAll(accountId: string): Promise<{ profile: Record<string, unknown> | null; onboarding: Record<string, unknown> | null; prefs: Record<string, unknown> | null }>;
  upsertProfile(accountId: string, displayName: string, nowIso: string): Promise<void>;
  upsertOnboarding(accountId: string, flags: Partial<Record<OnboardingFlag, boolean>>, nowIso: string): Promise<void>;
  upsertPrefs(accountId: string, prefs: { email?: string | null; deadline_reminder?: boolean }, nowIso: string): Promise<void>;
  insertFeedback(row: { accountId: string | null; page: string; message: string; ipHash: string; nowIso: string }): Promise<void>;
  countFeedback(ipHash: string, sinceIso: string): Promise<number>;
}

export interface Deps {
  store: Store;
  /** JSON-RPC call to a NEAR testnet node; the whole response object (`result` or `error`). */
  rpc: (method: string, params: unknown) => Promise<any>;
  now: () => number;
  /** Address of the caller (for the rate limit of the feedback). */
  ip: string;
  /** Secret that makes the hash of an address one-way for practical purposes. */
  ipSalt: string;
}

export interface Answer {
  status: number;
  body: unknown;
}

const NAMED = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;
const IMPLICIT = /^[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const AUTH_FIELDS = ["accountId", "publicKey", "signature", "message", "nonce", "recipient"] as const;

// an answer is told from request data by identity, never by its keys: a client can send a `status` field in `data`
const answers = new WeakSet<object>();
const isAnswer = (x: unknown): x is Answer => typeof x === "object" && x !== null && answers.has(x);
const fail = (status: number, code: string, message: string): Answer => {
  const a: Answer = { status, body: { error: { code, message } } };
  answers.add(a);
  return a;
};
const SIGNATURE_STATUS: Record<VerifyError, number> = { bad_public_key: 400, bad_signature_format: 400, bad_nonce: 400, nonce_expired: 401, wrong_recipient: 401, wrong_message: 401, invalid_signature: 401 };

async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

type KeyCheck = "ok" | "no" | "unavailable";

/** Does the account own the key? Only a full access key counts. An implicit account that does not exist yet owns the key whose hex is its id. */
export async function keyBelongsToAccount(rpc: Deps["rpc"], accountId: string, publicKey: string, publicKeyBytes: Uint8Array): Promise<KeyCheck> {
  let r: any;
  try {
    r = await rpc("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey });
  } catch {
    return "unavailable";
  }
  if (r?.result && r.result.permission !== undefined && r.result.error === undefined) return r.result.permission === "FullAccess" ? "ok" : "no";
  const name: string = r?.error?.cause?.name ?? "";
  const text = String(r?.result?.error ?? r?.error?.data ?? "");
  const unknownAccount = name === "UNKNOWN_ACCOUNT" || (/does not exist/i.test(text) && !/access key/i.test(text));
  const unknownKey = name === "UNKNOWN_ACCESS_KEY" || /access key/i.test(text);
  if (!unknownAccount && !unknownKey) return "unavailable";
  const implicitKey = IMPLICIT.test(accountId) && bytesToHex(publicKeyBytes) === accountId;
  if (unknownAccount) return implicitKey ? "ok" : "no";
  // Some nodes (fastnear) answer "access key ... does not exist while viewing" also when the ACCOUNT is missing: ask the account itself.
  if (!implicitKey) return "no";
  let a: any;
  try {
    a = await rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
  } catch {
    return "unavailable";
  }
  if (a?.result && a.result.error === undefined && a.result.amount !== undefined) return "no"; // the account exists and does not have the key (rotated away)
  const aname: string = a?.error?.cause?.name ?? "";
  const atext = String(a?.result?.error ?? a?.error?.data ?? "");
  if (aname === "UNKNOWN_ACCOUNT" || /does not exist/i.test(atext)) return "ok";
  return "unavailable";
}

function checkAuthShape(b: Record<string, unknown>): SignedRequest | Answer {
  for (const f of AUTH_FIELDS) if (typeof b[f] !== "string" || (b[f] as string).length === 0 || (b[f] as string).length > 512) return fail(400, "invalid_request", `${f} must be a non-empty string`);
  const accountId = b.accountId as string;
  if (accountId.length > 64 || !(NAMED.test(accountId) || IMPLICIT.test(accountId))) return fail(400, "invalid_request", "accountId is not a NEAR account id");
  return { accountId, publicKey: b.publicKey as string, signature: b.signature as string, message: b.message as string, nonce: b.nonce as string, recipient: b.recipient as string };
}

/** The signature, the key of the account, and the nonce, in that order (a nonce is spent only by a valid signature of a key the account owns). Returns the account id or the answer to send. */
async function authenticate(b: Record<string, unknown>, action: string, deps: Deps): Promise<string | Answer> {
  const req = checkAuthShape(b);
  if (isAnswer(req)) return req;
  const v = await verifyNep413(req, action, deps.now());
  if (!v.ok) return fail(SIGNATURE_STATUS[v.error], v.error, `the signed message was refused: ${v.error}`);
  const owns = await keyBelongsToAccount(deps.rpc, req.accountId, req.publicKey, v.publicKeyBytes);
  if (owns === "unavailable") return fail(503, "rpc_unavailable", "the NEAR network did not answer; try again");
  if (owns === "no") return fail(403, "key_not_owned", `${req.publicKey} is not a full access key of ${req.accountId}`);
  if (!(await deps.store.useNonce(req.nonce, req.accountId, deps.now()))) return fail(401, "nonce_used", "this nonce was used before; sign again with a new one");
  return req.accountId;
}

function objectData(b: Record<string, unknown>): Record<string, unknown> | Answer {
  const d = b.data;
  if (d === null || typeof d !== "object" || Array.isArray(d)) return fail(400, "invalid_request", "data must be an object");
  return d as Record<string, unknown>;
}

function onlyKeys(d: Record<string, unknown>, allowed: readonly string[]): Answer | null {
  const extra = Object.keys(d).find((k) => !allowed.includes(k));
  return extra === undefined ? null : fail(400, "invalid_request", `unknown field ${extra}`);
}

export async function handleRequest(raw: unknown, deps: Deps): Promise<Answer> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail(400, "invalid_request", "body must be a JSON object");
  const b = raw as Record<string, unknown>;
  const action = b.action;
  if (action === "feedback") return feedback(b, deps);
  if (action !== "get" && action !== "upsert_profile" && action !== "upsert_onboarding" && action !== "upsert_prefs") return fail(400, "invalid_request", "action must be get, upsert_profile, upsert_onboarding, upsert_prefs or feedback");

  const iso = new Date(deps.now()).toISOString();
  if (action === "get") {
    const account = await authenticate(b, action, deps);
    if (typeof account !== "string") return account;
    return { status: 200, body: { account_id: account, ...(await deps.store.getAll(account)) } };
  }

  const data = objectData(b);
  if (isAnswer(data)) return data;
  // the data is checked before the signature is spent, so that a typo does not burn a nonce
  if (action === "upsert_profile") {
    const bad = onlyKeys(data, ["display_name"]);
    if (bad) return bad;
    const name = data.display_name;
    if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 40 || CONTROL.test(name)) return fail(400, "invalid_request", "display_name must be 1 to 40 characters without control characters");
    const account = await authenticate(b, action, deps);
    if (typeof account !== "string") return account;
    await deps.store.upsertProfile(account, name.trim(), iso);
    return { status: 200, body: { account_id: account, ...(await deps.store.getAll(account)) } };
  }
  if (action === "upsert_onboarding") {
    const bad = onlyKeys(data, ONBOARDING_FLAGS);
    if (bad) return bad;
    const flags: Partial<Record<OnboardingFlag, boolean>> = {};
    for (const f of ONBOARDING_FLAGS) {
      if (data[f] === undefined) continue;
      if (typeof data[f] !== "boolean") return fail(400, "invalid_request", `${f} must be a boolean`);
      flags[f] = data[f] as boolean;
    }
    if (Object.keys(flags).length === 0) return fail(400, "invalid_request", "give at least one step flag");
    const account = await authenticate(b, action, deps);
    if (typeof account !== "string") return account;
    await deps.store.upsertOnboarding(account, flags, iso);
    return { status: 200, body: { account_id: account, ...(await deps.store.getAll(account)) } };
  }
  const bad = onlyKeys(data, ["email", "deadline_reminder"]);
  if (bad) return bad;
  const prefs: { email?: string | null; deadline_reminder?: boolean } = {};
  if (data.email !== undefined) {
    if (data.email !== null && (typeof data.email !== "string" || data.email.length > 254 || !EMAIL.test(data.email))) return fail(400, "invalid_request", "email must be an email address or null");
    prefs.email = data.email as string | null;
  }
  if (data.deadline_reminder !== undefined) {
    if (typeof data.deadline_reminder !== "boolean") return fail(400, "invalid_request", "deadline_reminder must be a boolean");
    prefs.deadline_reminder = data.deadline_reminder;
  }
  if (Object.keys(prefs).length === 0) return fail(400, "invalid_request", "give email or deadline_reminder");
  const account = await authenticate(b, action, deps);
  if (typeof account !== "string") return account;
  await deps.store.upsertPrefs(account, prefs, iso);
  return { status: 200, body: { account_id: account, ...(await deps.store.getAll(account)) } };
}

/** Feedback needs no signature. When the six signature fields are there it is signed and the account is kept; when some are there and some not, it is refused. */
async function feedback(b: Record<string, unknown>, deps: Deps): Promise<Answer> {
  const d = objectData(b);
  if (isAnswer(d)) return d;
  const bad = onlyKeys(d, ["page", "message"]);
  if (bad) return bad;
  const page = d.page;
  const message = d.message;
  if (typeof page !== "string" || page.length < 1 || page.length > 200 || CONTROL.test(page)) return fail(400, "invalid_request", "page must be 1 to 200 characters");
  if (typeof message !== "string" || message.trim().length < 1 || message.length > 2000) return fail(400, "invalid_request", "message must be 1 to 2000 characters");
  const present = AUTH_FIELDS.filter((f) => b[f] !== undefined);
  if (present.length !== 0 && present.length !== AUTH_FIELDS.length) return fail(400, "invalid_request", "give all six signature fields or none");
  const ipHash = await sha256Hex(`${deps.ipSalt}:${deps.ip}`);
  const since = new Date(deps.now() - 3_600_000).toISOString();
  if ((await deps.store.countFeedback(ipHash, since)) >= FEEDBACK_PER_IP_PER_HOUR) return fail(429, "rate_limited", `at most ${FEEDBACK_PER_IP_PER_HOUR} feedback messages per hour from one address`);
  let accountId: string | null = null;
  if (present.length > 0) {
    const who = await authenticate(b, "feedback", deps);
    if (typeof who !== "string") return who;
    accountId = who;
  }
  await deps.store.insertFeedback({ accountId, page, message, ipHash, nowIso: new Date(deps.now()).toISOString() });
  return { status: 201, body: { ok: true, signed: accountId !== null } };
}
