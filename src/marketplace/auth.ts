import type Database from "better-sqlite3";
import { ApiError } from "../api/errors.js";
import { row } from "../api/format.js";

/** Kunci voucher anggota `active`; selain itu 403 `member_not_active` (404 `member_not_found` bila tidak terdaftar). */
export function activeMemberKey(db: Database.Database, circleId: string, account: string): string {
  const member = row<{ pubkey_voucher: string; status: string }>(
    db,
    "SELECT pubkey_voucher, status FROM members WHERE circle_id = ? AND account_id = ?",
    circleId,
    account,
  );
  if (!member) throw new ApiError(404, "member_not_found", `Account ${account} is not a member`, { account });
  if (member.status !== "active") throw new ApiError(403, "member_not_active", `Account ${account} is not active`, { account, status: member.status });
  return member.pubkey_voucher;
}

/** Kunci voucher anggota apa pun statusnya (untuk memeriksa tanda tangan yang tidak membutuhkan anggota aktif). */
export function memberKeys(db: Database.Database, circleId: string, accounts: readonly string[]): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const account of accounts) {
    const found = row<{ pubkey_voucher: string }>(db, "SELECT pubkey_voucher FROM members WHERE circle_id = ? AND account_id = ?", circleId, account);
    if (found) keys[account] = found.pubkey_voucher;
  }
  return keys;
}
