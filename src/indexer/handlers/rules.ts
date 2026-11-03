// Interface 0.0.12 (BE-065, review BE-064 C-9): the events of the bond with an arbiter (CT-094), of `freeze_member` (CT-095) and of the official contracts (CT-096). The SDK parser
// does not know them yet, so they are raw handlers (like the escrow events); a later SDK that learns the names does not change what these do. The data is the object of the NEP-297 array.
//
// Stake and limit of the two parties are kept equal to the contract: `bond_slashed` carries the new stake of both, and the limit that `rule_deal` lowers (`limit = min(limit, stake - bond_locked)`)
// comes in the `limits_updated` that `rule_deal` emits since the fix of review BE-064 C-9 (commit `7d9d689` of the contracts): `handlers/risk.ts` writes it, with the reason `ruling`.
import { IndexerHaltError } from "../errors.js";
import { units } from "../units.js";
import type { HandlerContext } from "./context.js";
import type { RawHandler } from "./escrow.js";

const str = (d: Record<string, unknown>, k: string): string => {
  const v = d[k];
  if (typeof v !== "string") throw new IndexerHaltError(`event 0.0.12: field ${k} harus string`);
  return v;
};
const opt = (d: Record<string, unknown>, k: string): string | null => (typeof d[k] === "string" ? (d[k] as string) : null);
const int = (d: Record<string, unknown>, k: string): number => {
  const v = d[k];
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new IndexerHaltError(`event 0.0.12: field ${k} harus integer >= 0`);
  return n;
};

function log(ctx: HandlerContext, bundleId: number, event: string, account: string | null, amount: bigint | null, detail: string | null): void {
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO deal_events (circle_id, bundle_id, event, account_id, amount, detail, block_height, receipt_id, log_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.circleId, bundleId, event, account, amount, detail, ctx.block.height, ctx.receiptId, ctx.logIndex);
}

/** Clears the lock flag of `account` in the deal; the deal is `closed` once neither bond is locked. */
function unlock(ctx: HandlerContext, bundleId: number, account: string): void {
  ctx.db
    .prepare(
      `UPDATE deals SET locked_a = CASE WHEN party_a = ? THEN 0 ELSE locked_a END, locked_b = CASE WHEN party_b = ? THEN 0 ELSE locked_b END
       WHERE circle_id = ? AND bundle_id = ?`,
    )
    .run(account, account, ctx.circleId, bundleId);
  ctx.db
    .prepare("UPDATE deals SET state = 'closed', closed_block = ? WHERE circle_id = ? AND bundle_id = ? AND locked_a = 0 AND (party_b IS NULL OR locked_b = 0)")
    .run(ctx.block.height, ctx.circleId, bundleId);
}

export const ruleRawHandlers: Record<string, RawHandler> = {
  bond_locked(ctx, d) {
    const bundleId = int(d, "bundle_id");
    const account = str(d, "account_id");
    const amount = units(str(d, "amount"), "amount");
    const existing = ctx.db.prepare("SELECT party_a, party_b FROM deals WHERE circle_id = ? AND bundle_id = ?").get(ctx.circleId, bundleId) as { party_a: string; party_b: string | null } | undefined;
    if (!existing) {
      ctx.db.prepare("INSERT INTO deals (circle_id, bundle_id, party_a, bond_each, opened_block) VALUES (?, ?, ?, ?, ?)").run(ctx.circleId, bundleId, account, amount, ctx.block.height);
    } else if (existing.party_b === null && existing.party_a !== account) {
      ctx.db.prepare("UPDATE deals SET party_b = ?, locked_b = 1 WHERE circle_id = ? AND bundle_id = ?").run(account, ctx.circleId, bundleId);
    }
    log(ctx, bundleId, "bond_locked", account, amount, null);
  },
  deal_confirmed(ctx, d) {
    log(ctx, int(d, "bundle_id"), "deal_confirmed", str(d, "account_id"), null, `of ${str(d, "of")}`);
  },
  deal_disputed(ctx, d) {
    const bundleId = int(d, "bundle_id");
    ctx.db
      .prepare("UPDATE deals SET state = 'disputed', complainant = ?, accused = ?, evidence_hash = ?, disputed_at_ns = ? WHERE circle_id = ? AND bundle_id = ? AND state = 'open'")
      .run(str(d, "complainant"), str(d, "accused"), str(d, "evidence_hash"), units(str(d, "disputed_at"), "disputed_at"), ctx.circleId, bundleId);
    log(ctx, bundleId, "deal_disputed", str(d, "complainant"), null, `accused ${str(d, "accused")}`);
  },
  deal_ruled(ctx, d) {
    const bundleId = int(d, "bundle_id");
    ctx.db.prepare("UPDATE deals SET arbiter = ?, verdict = ? WHERE circle_id = ? AND bundle_id = ?").run(str(d, "arbiter"), str(d, "verdict"), ctx.circleId, bundleId);
    log(ctx, bundleId, "deal_ruled", str(d, "arbiter"), null, str(d, "verdict"));
  },
  bond_slashed(ctx, d) {
    const bundleId = int(d, "bundle_id");
    const from = str(d, "from");
    const to = str(d, "to");
    const amount = units(str(d, "amount"), "amount");
    const setStake = ctx.db.prepare("UPDATE members SET stake = ?, updated_block = ? WHERE circle_id = ? AND account_id = ?");
    for (const [account, stake, key] of [[from, str(d, "from_stake"), "from_stake"], [to, str(d, "to_stake"), "to_stake"]] as const) {
      if (setStake.run(units(stake, key), ctx.block.height, ctx.circleId, account).changes === 0) throw new IndexerHaltError(`anggota ${account} tidak ditemukan di D9`);
    }
    // the whole bond leaves the lock of the loser (`slash_then_release`)
    unlock(ctx, bundleId, from);
    log(ctx, bundleId, "bond_slashed", from, amount, `to ${to}`);
  },
  bond_released(ctx, d) {
    const bundleId = int(d, "bundle_id");
    const account = str(d, "account_id");
    const reason = str(d, "reason");
    unlock(ctx, bundleId, account);
    log(ctx, bundleId, "bond_released", account, units(str(d, "amount"), "amount"), reason);
  },

  freeze_proposed(ctx, d) {
    ctx.db
      .prepare(
        `INSERT INTO member_freezes (circle_id, account_id, state, eta_ns, reason_hash, block_height) VALUES (?, ?, 'pending', ?, ?, ?)
         ON CONFLICT (circle_id, account_id) DO UPDATE SET state = 'pending', eta_ns = excluded.eta_ns, reason_hash = excluded.reason_hash, from_epoch = NULL, block_height = excluded.block_height`,
      )
      .run(ctx.circleId, str(d, "account_id"), units(str(d, "eta"), "eta"), opt(d, "reason_hash"), ctx.block.height);
  },
  member_frozen(ctx, d) {
    ctx.db
      .prepare(
        `INSERT INTO member_freezes (circle_id, account_id, state, from_epoch, block_height) VALUES (?, ?, 'frozen', ?, ?)
         ON CONFLICT (circle_id, account_id) DO UPDATE SET state = 'frozen', from_epoch = excluded.from_epoch, block_height = excluded.block_height`,
      )
      .run(ctx.circleId, str(d, "account_id"), int(d, "from_epoch"), ctx.block.height);
  },
  freeze_cancelled(ctx, d) {
    ctx.db.prepare("DELETE FROM member_freezes WHERE circle_id = ? AND account_id = ? AND state = 'pending'").run(ctx.circleId, str(d, "account_id"));
  },
  member_unfrozen(ctx, d) {
    ctx.db.prepare("DELETE FROM member_freezes WHERE circle_id = ? AND account_id = ?").run(ctx.circleId, str(d, "account_id"));
  },

  asset_contracts_set(ctx, d) {
    const contracts = d.contracts;
    if (!Array.isArray(contracts) || contracts.some((c) => typeof c !== "string")) throw new IndexerHaltError("event asset_contracts_set: contracts harus daftar akun");
    const assetType = str(d, "asset_type");
    if (contracts.length === 0) {
      ctx.db.prepare("DELETE FROM official_contracts WHERE circle_id = ? AND asset_type = ?").run(ctx.circleId, assetType);
      return;
    }
    ctx.db
      .prepare(
        `INSERT INTO official_contracts (circle_id, asset_type, contracts, block_height) VALUES (?, ?, ?, ?)
         ON CONFLICT (circle_id, asset_type) DO UPDATE SET contracts = excluded.contracts, block_height = excluded.block_height`,
      )
      .run(ctx.circleId, assetType, JSON.stringify(contracts), ctx.block.height);
  },
};
