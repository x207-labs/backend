// Buku intent barter off-chain (BE-035, D8): `POST/GET /x207/circles/{circle}/intents`.
// Hash intent dihitung ulang dari isi (SD-047); backend tidak mengirim transaksi, jadi `post_intent` dikembalikan sebagai
// argumen panggilan untuk anggota, dan status on-chain dibaca dari event `intent_posted` di `events_raw`.
import type Database from "better-sqlite3";
import { BarterFormatError, intentHash, intentHashBase58, validateIntent, verifyIntentSignature, type BarterIntent } from "@x207/core";
import { ApiError, invalidRequest } from "../api/errors.js";
import { row, rows } from "../api/format.js";
import { decodeCursor, encodeCursor, parseLimit } from "../api/pagination.js";
import type { Route } from "../api/router.js";
import { activeMemberKey } from "./auth.js";
import { isoSeconds } from "./common.js";
import { eventField } from "./event-data.js";

const STATUSES = ["open", "matched", "expired", "all"] as const;

interface IntentRow {
  id: bigint;
  intent_hash: string;
  intent_hash_b58: string;
  account_id: string;
  offer_service: string;
  offer_calls: bigint;
  offer_value: string;
  need_service: string;
  need_calls: bigint;
  need_value: string;
  expires_at: bigint;
  nonce: string;
  signature: string;
  status: string;
  created_at_ms: bigint;
}

function onchain(db: Database.Database, contractId: string, hashB58: string) {
  const posted = row<{ block_height: bigint; account: string | null }>(
    db,
    `SELECT block_height, ${eventField('account_id')} AS account FROM events_raw
     WHERE contract_id = ? AND event = 'intent_posted' AND ${eventField('intent_hash')} = ? LIMIT 1`,
    contractId,
    hashB58,
  );
  return {
    method: "post_intent",
    args: { intent_hash: hashB58 },
    posted: posted !== undefined,
    ...(posted ? { blockHeight: Number(posted.block_height) } : {}),
  };
}

function intentView(db: Database.Database, contractId: string, r: IntentRow, nowSeconds: number) {
  const expired = r.status === "open" && Number(r.expires_at) <= nowSeconds;
  return {
    intentHash: r.intent_hash,
    intentHashBase58: r.intent_hash_b58,
    account: r.account_id,
    offer: { service: r.offer_service, calls: Number(r.offer_calls), value: r.offer_value },
    need: { service: r.need_service, calls: Number(r.need_calls), value: r.need_value },
    expiresAt: isoSeconds(Number(r.expires_at)),
    nonce: r.nonce,
    signature: r.signature,
    status: expired ? "expired" : r.status,
    onchain: onchain(db, contractId, r.intent_hash_b58),
  };
}

function parseIntentBody(body: unknown): { intent: BarterIntent; signature: string } {
  if (body === null || typeof body !== "object") throw invalidRequest("body must be an object");
  const { intent, signature } = body as { intent?: unknown; signature?: unknown };
  if (typeof signature !== "string") throw invalidRequest("signature must be a string");
  if (intent === null || typeof intent !== "object") throw invalidRequest("intent must be an object");
  return { intent: intent as BarterIntent, signature };
}

export const intentRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/x207/circles/{circle}/intents",
    circleScoped: true,
    handler: ({ db, circle, body, now }) => {
      const { intent, signature } = parseIntentBody(body);
      try {
        validateIntent(intent);
      } catch (error) {
        if (error instanceof BarterFormatError) throw invalidRequest(error.message);
        throw error;
      }
      if (intent.circle !== circle.contract_id) {
        throw invalidRequest("intent.circle must be the circle contract account", { expected: circle.contract_id, got: intent.circle });
      }
      const nowSeconds = Math.floor(now() / 1000);
      if (intent.expiresAt <= nowSeconds) throw invalidRequest("expiresAt has already passed", { expiresAt: intent.expiresAt });
      const pubkey = activeMemberKey(db, circle.circle_id, intent.account);
      if (!verifyIntentSignature(intent, signature, pubkey)) {
        throw new ApiError(401, "invalid_signature", "Intent signature does not match the member's voucher key", { account: intent.account });
      }
      const hash = intentHash(intent);
      const hashB58 = intentHashBase58(intent);
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO intents (circle_id, intent_hash, intent_hash_b58, account_id, offer_service, offer_calls, offer_value,
             need_service, need_calls, need_value, expires_at, nonce, signature, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(circle.circle_id, hash, hashB58, intent.account, intent.offer.service, intent.offer.calls, intent.offer.value,
          intent.need.service, intent.need.calls, intent.need.value, intent.expiresAt, intent.nonce, signature, now());
      if (inserted.changes === 0) throw new ApiError(409, "already_exists", "An intent with this hash is already recorded", { intentHash: hash });
      const stored = row<IntentRow>(db, "SELECT * FROM intents WHERE circle_id = ? AND intent_hash = ?", circle.circle_id, hash) as IntentRow;
      return { status: 201, body: intentView(db, circle.contract_id, stored, nowSeconds) };
    },
  },
  {
    method: "GET",
    pattern: "/x207/circles/{circle}/intents",
    circleScoped: true,
    handler: ({ db, circle, query, now }) => {
      const limit = parseLimit(query);
      const status = query.get("status") ?? "open";
      if (!(STATUSES as readonly string[]).includes(status)) throw invalidRequest("unknown status", { status, allowed: STATUSES });
      const account = query.get("account");
      const cursor = decodeCursor(query);
      const after = cursor && typeof cursor.a === "number" ? cursor.a : null;
      if (cursor && after === null) throw invalidRequest("invalid cursor");
      const nowSeconds = Math.floor(now() / 1000);

      const where = ["circle_id = ?"];
      const args: unknown[] = [circle.circle_id];
      if (status === "open") where.push("status = 'open' AND expires_at > ?"), args.push(nowSeconds);
      else if (status === "expired") where.push("status = 'open' AND expires_at <= ?"), args.push(nowSeconds);
      else if (status === "matched") where.push("status = 'matched'");
      if (account !== null) where.push("account_id = ?"), args.push(account);
      if (after !== null) where.push("id > ?"), args.push(after);
      const found = rows<IntentRow>(db, `SELECT * FROM intents WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`, ...args, limit + 1);
      const page = found.slice(0, limit);
      const items = page.map((r) => intentView(db, circle.contract_id, r, nowSeconds));
      const last = page[page.length - 1];
      const next = found.length > limit && last ? encodeCursor({ a: Number(last.id) }) : null;
      return { status: 200, body: { items, nextCursor: next } };
    },
  },
];
