import { requireChange, type HandlerMap } from "./context.js";

/** BE-038 (F8): `asset_class_set` upserts D10; `grant_offered`, `grant_activated` and `grant_revoked` move a D11 grant forward. */
export const grantHandlers: HandlerMap = {
  asset_class_set(ctx, e) {
    ctx.db
      .prepare(
        `INSERT INTO asset_classes (circle_id, asset_type, class, block_height, receipt_id, log_index) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (circle_id, asset_type) DO UPDATE SET class = excluded.class, block_height = excluded.block_height,
           receipt_id = excluded.receipt_id, log_index = excluded.log_index
         WHERE excluded.block_height > asset_classes.block_height
            OR (excluded.block_height = asset_classes.block_height AND excluded.log_index >= asset_classes.log_index)`,
      )
      .run(ctx.circleId, e.asset_type, e.class, ctx.block.height, ctx.receiptId, ctx.logIndex);
  },

  grant_offered(ctx, e) {
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO grants (circle_id, grant_id, asset_type, grantor, class, unit, unit_price, expires_at_ns, status,
           block_height, receipt_id, log_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?)`,
      )
      .run(ctx.circleId, Number(e.grant_id), e.asset_type, e.grantor, e.class, e.unit, e.unit_price, e.expires_at, ctx.block.height, ctx.receiptId, ctx.logIndex);
  },

  grant_activated(ctx, e) {
    const changed = ctx.db
      .prepare("UPDATE grants SET status = 'active', grantee = ?, delivery_pubkey = ? WHERE circle_id = ? AND grant_id = ? AND status = 'offered'")
      .run(e.grantee, e.delivery_pubkey, ctx.circleId, Number(e.grant_id));
    if (changed.changes === 0 && !alreadyActive(ctx, Number(e.grant_id))) requireChange(0, `grant ${e.grant_id}`);
    // class A: the escrow delivered the asset to the grantee
    ctx.db.prepare("UPDATE escrows SET state = 'delivered' WHERE circle_id = ? AND grant_id = ? AND state = 'held'").run(ctx.circleId, Number(e.grant_id));
    accountDelivered(ctx, Number(e.grant_id), e.grantee, e.delivery_pubkey);
  },

  grant_revoked(ctx, e) {
    const status = e.reason === "expired" ? "expired" : "revoked";
    const changed = ctx.db
      .prepare("UPDATE grants SET status = ?, revoke_reason = ? WHERE circle_id = ? AND grant_id = ? AND status IN ('offered','active')")
      .run(status, e.reason, ctx.circleId, Number(e.grant_id));
    if (changed.changes === 0 && !alreadyFinal(ctx, Number(e.grant_id))) requireChange(0, `grant ${e.grant_id}`);
    // class A: the grantor took the asset back (the contract refuses any other revoke while the escrow holds it)
    ctx.db.prepare("UPDATE escrows SET state = 'cancelled' WHERE circle_id = ? AND grant_id = ? AND state = 'held'").run(ctx.circleId, Number(e.grant_id));
    ctx.db.prepare("UPDATE account_escrows SET state = 'cancelled' WHERE circle_id = ? AND grant_id = ? AND state = 'held'").run(ctx.circleId, Number(e.grant_id));
  },
};

type Ctx = Parameters<NonNullable<HandlerMap["grant_activated"]>>[0];

/**
 * BE-110 (ADR 0.0.18, 1.3 and 1.4): an account escrow was delivered, the account changed hands. Two things follow in the read model, both once (a replay finds the escrow no longer `held`):
 * the reputation of the account starts again from the time of the block (`reputation_resets`), and, when the account is a member of the circle (item #14), its voucher key is the
 * `delivery_pubkey` from now on (ADR 1.4: the contract rotates it on delivery, so the key of the seller must stop working here too).
 * The ADR names no event for the rotation; the key is taken from `grant_activated`, whose `delivery_pubkey` is the key the contract rotates to.
 */
function accountDelivered(ctx: Ctx, grantId: number, grantee: string, deliveryPubkey: string | null): void {
  const escrow = ctx.db.prepare("SELECT account_id FROM account_escrows WHERE circle_id = ? AND grant_id = ? AND state = 'held'").get(ctx.circleId, grantId) as { account_id: string } | undefined;
  if (escrow === undefined) return;
  ctx.db.prepare("UPDATE account_escrows SET state = 'delivered', new_owner = ? WHERE circle_id = ? AND grant_id = ?").run(grantee, ctx.circleId, grantId);
  ctx.db
    .prepare("INSERT OR IGNORE INTO reputation_resets (circle_id, account_id, grant_id, new_owner, since_ms, block_height) VALUES (?, ?, ?, ?, ?, ?)")
    .run(ctx.circleId, escrow.account_id, grantId, grantee, Number(ctx.block.timestampNs / 1_000_000n), ctx.block.height);
  if (deliveryPubkey !== null) {
    ctx.db.prepare("UPDATE members SET pubkey_voucher = ?, updated_block = ? WHERE circle_id = ? AND account_id = ?").run(deliveryPubkey, ctx.block.height, ctx.circleId, escrow.account_id);
  }
}

/** A replay of `grant_activated` finds the grant already active (or later); that is not an error. */
function alreadyActive(ctx: Ctx, grantId: number): boolean {
  return ctx.db.prepare("SELECT 1 FROM grants WHERE circle_id = ? AND grant_id = ?").get(ctx.circleId, grantId) !== undefined;
}

function alreadyFinal(ctx: Ctx, grantId: number): boolean {
  return ctx.db.prepare("SELECT 1 FROM grants WHERE circle_id = ? AND grant_id = ? AND status IN ('revoked','expired')").get(ctx.circleId, grantId) !== undefined;
}
