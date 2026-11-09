// BE-116: Edge Function `x207-account` (Deno). One POST endpoint; the account is proven by a NEP-413 signature, never by a Supabase login. The tables are only reachable with the service role key
// that the platform puts in this function's environment (RLS is on, there is no policy for anon or authenticated).
// Env: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (set by the platform), X207_RPC_URL (default https://rpc.testnet.fastnear.com), X207_IP_SALT (optional: salt of the hash of the address of a feedback).
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleRequest, type Store } from "./handler.ts";

const ALLOWED_ORIGINS = ["https://x207.vercel.app", "http://localhost:5207"];
const RPC_URL = Deno.env.get("X207_RPC_URL") ?? "https://rpc.testnet.fastnear.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
const MAX_BODY = 16 * 1024;

const check = <T>(r: { data?: T; error: { message: string; code?: string } | null }, what: string): T | undefined => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

const store: Store = {
  async useNonce(nonce, accountId, nowMs) {
    // old nonces are useless (a nonce older than 5 minutes is refused anyway): one cheap clean-up per use
    await db.from("nonces_x207").delete().lt("created_at", new Date(nowMs - 3_600_000).toISOString());
    const r = await db.from("nonces_x207").insert({ nonce, account_id: accountId, created_at: new Date(nowMs).toISOString() });
    if (r.error?.code === "23505") return false;
    if (r.error) throw new Error(`nonce: ${r.error.message}`);
    return true;
  },
  async getAll(accountId) {
    const one = async (table: string) => check(await db.from(table).select("*").eq("account_id", accountId).maybeSingle(), table) ?? null;
    const [profile, onboarding, prefs] = await Promise.all([one("profiles_x207"), one("onboarding_x207"), one("notify_prefs_x207")]);
    return { profile, onboarding, prefs };
  },
  async upsertProfile(accountId, displayName, nowIso) {
    check(await db.from("profiles_x207").upsert({ account_id: accountId, display_name: displayName, updated_at: nowIso }, { onConflict: "account_id" }), "profile");
  },
  async upsertOnboarding(accountId, flags, nowIso) {
    check(await db.from("onboarding_x207").upsert({ account_id: accountId, ...flags, updated_at: nowIso }, { onConflict: "account_id" }), "onboarding");
  },
  async upsertPrefs(accountId, prefs, nowIso) {
    check(await db.from("notify_prefs_x207").upsert({ account_id: accountId, ...prefs, updated_at: nowIso }, { onConflict: "account_id" }), "prefs");
  },
  async insertFeedback(row) {
    check(await db.from("feedback_x207").insert({ account_id: row.accountId, page: row.page, message: row.message, ip_hash: row.ipHash, created_at: row.nowIso }), "feedback");
  },
  async countFeedback(ipHash, sinceIso) {
    const r = await db.from("feedback_x207").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", sinceIso);
    if (r.error) throw new Error(`feedback count: ${r.error.message}`);
    return r.count ?? 0;
  },
};

async function rpc(method: string, params: unknown): Promise<unknown> {
  const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "x207", method, params }), signal: AbortSignal.timeout(8000) });
  return r.json();
}

function corsFor(origin: string | null): Record<string, string> {
  const base = { Vary: "Origin" };
  if (origin !== null && ALLOWED_ORIGINS.includes(origin)) {
    return { ...base, "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info", "Access-Control-Max-Age": "600" };
  }
  return base;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = corsFor(req.headers.get("origin"));
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(405, { error: { code: "method_not_allowed", message: "POST only" } });
  const text = await req.text();
  if (text.length > MAX_BODY) return reply(413, { error: { code: "payload_too_large", message: `at most ${MAX_BODY} bytes` } });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { error: { code: "invalid_request", message: "body must be JSON" } });
  }
  // behind the platform proxy the address of the caller is the first hop of x-forwarded-for (cf-connecting-ip when there is one)
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  try {
    const answer = await handleRequest(body, { store, rpc, now: () => Date.now(), ip, ipSalt: Deno.env.get("X207_IP_SALT") ?? SUPABASE_URL });
    return reply(answer.status, answer.body);
  } catch (err) {
    console.error("x207-account failed", err instanceof Error ? err.message : String(err));
    return reply(500, { error: { code: "internal_error", message: "internal error" } });
  }
});
