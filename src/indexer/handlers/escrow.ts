import { IndexerHaltError } from "../errors.js";
import { units } from "../units.js";
import type { HandlerContext } from "./context.js";

/**
 * CT-075 (F8 class A): the two events of the escrow. The SDK parser does not know them yet, so the indexer calls these with the raw data
 * (`rawHandlers`), whether or not a later SDK version learns the names.
 */
export type RawHandler = (ctx: HandlerContext, data: Record<string, unknown>) => void;

const str = (data: Record<string, unknown>, field: string): string => {
  const value = data[field];
  if (typeof value !== "string") throw new IndexerHaltError(`event escrow: field ${field} harus string`);
  return value;
};
const int = (data: Record<string, unknown>, field: string): number => {
  const value = data[field];
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new IndexerHaltError(`event escrow: field ${field} harus integer`);
  return n;
};

/** An amount of a NEP-141 token, up to 2^128 - 1 (a token with 18 decimals passes 2^63): kept as the decimal text. */
function tokenAmount(value: string): string {
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) >= 1n << 128n) throw new IndexerHaltError(`event ft_escrow_held: amount bukan bilangan bulat 1..2^128-1: ${value}`);
  return value;
}

interface VoucherEvent {
  epoch: number;
  payer: string;
  payee: string;
  seq: number;
  cumulative_amount: string;
  mode: "cumulative" | "per_request";
}

/**
 * The registrations of this pair and epoch that came before the position of this event, newest first. The contract locks a pair while an
 * escrow payment is in flight, so the newest one is the registration that `complete_escrow` made.
 */
function earlierRegistrations(ctx: HandlerContext, epoch: number, payer: string, payee: string): VoucherEvent[] {
  const contract = (ctx.db.prepare("SELECT contract_id FROM circles WHERE circle_id = ?").get(ctx.circleId) as { contract_id: string } | undefined)?.contract_id;
  if (contract === undefined) throw new IndexerHaltError(`lingkaran ${ctx.circleId} tidak dikenal`);
  const rows = ctx.db
    .prepare(
      `SELECT data_json FROM events_raw WHERE contract_id = ? AND event = 'voucher_registered'
         AND (block_height < ? OR (block_height = ? AND (receipt_id < ? OR (receipt_id = ? AND log_index < ?))))
       ORDER BY block_height DESC, receipt_id DESC, log_index DESC`,
    )
    .all(contract, ctx.block.height, ctx.block.height, ctx.receiptId, ctx.receiptId, ctx.logIndex) as Array<{ data_json: string }>;
  const found: VoucherEvent[] = [];
  for (const row of rows) {
    const data = (JSON.parse(row.data_json) as VoucherEvent[])[0];
    if (data !== undefined && Number(data.epoch) === epoch && data.payer === payer && data.payee === payee) found.push({ ...data, seq: Number(data.seq) });
  }
  return found;
}

export const rawHandlers: Record<string, RawHandler> = {
  escrow_held(ctx, data) {
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO escrows (circle_id, grant_id, nft_contract, token_id, state, block_height, receipt_id, log_index)
         VALUES (?, ?, ?, ?, 'held', ?, ?, ?)`,
      )
      .run(ctx.circleId, int(data, "grant_id"), str(data, "nft_contract"), str(data, "token_id"), ctx.block.height, ctx.receiptId, ctx.logIndex);
  },

  /** CT-090: the escrow holds an exact amount of a NEP-141 token. The amount is in the units of that token, not credits. */
  ft_escrow_held(ctx, data) {
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO escrows (circle_id, grant_id, kind, ft_contract, amount, state, block_height, receipt_id, log_index)
         VALUES (?, ?, 'ft', ?, ?, 'held', ?, ?, ?)`,
      )
      .run(ctx.circleId, int(data, "grant_id"), str(data, "ft_contract"), tokenAmount(str(data, "amount")), ctx.block.height, ctx.receiptId, ctx.logIndex);
  },

  /**
   * `step` `complete`: the `nft_transfer` to the buyer failed. With `reverted` the contract took the registration of the voucher back, so D9
   * takes it back too: the obligation row returns to the registration before it (or goes), and the debt of the payer drops by `delta`. Without
   * `reverted` the contract kept the payment and the asset stays in the escrow (`stuck`). `step` `cancel`: nothing changes, the escrow is still held.
   */
  escrow_failed(ctx, data) {
    const grantId = int(data, "grant_id");
    const step = str(data, "step");
    if (step !== "complete") return;
    const reverted = data.reverted === true;
    if (!reverted) {
      ctx.db.prepare("UPDATE escrows SET state = 'stuck' WHERE circle_id = ? AND grant_id = ?").run(ctx.circleId, grantId);
      return;
    }
    const epoch = int(data, "epoch");
    const payer = str(data, "payer");
    const payee = str(data, "payee");
    const delta = units(str(data, "delta"), "delta");
    const [cancelled, before] = earlierRegistrations(ctx, epoch, payer, payee);
    if (cancelled === undefined) throw new IndexerHaltError(`escrow_failed: tidak ada voucher_registered untuk ${payer} -> ${payee} di epoch ${epoch}`);
    if (before === undefined) {
      ctx.db.prepare("DELETE FROM obligations WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?").run(ctx.circleId, epoch, payer, payee);
    } else {
      ctx.db
        .prepare(
          `UPDATE obligations SET seq = ?, cumulative_amount = ?, registration_mode = ? WHERE circle_id = ? AND epoch = ? AND debtor = ? AND creditor = ?
             AND seq = ?`,
        )
        .run(before.seq, units(before.cumulative_amount, "cumulative_amount"), before.mode, ctx.circleId, epoch, payer, payee, cancelled.seq);
    }
    const debt = ctx.db
      .prepare("UPDATE members SET outstanding_debt = outstanding_debt - ?, updated_block = ? WHERE circle_id = ? AND account_id = ? AND outstanding_debt >= ?")
      .run(delta, ctx.block.height, ctx.circleId, payer, delta);
    if (debt.changes === 0) throw new IndexerHaltError(`escrow_failed: utang ${payer} lebih kecil dari ${delta}`);
    ctx.db.prepare("UPDATE escrows SET state = 'held' WHERE circle_id = ? AND grant_id = ?").run(ctx.circleId, grantId);
  },
};
