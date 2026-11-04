import type Database from "better-sqlite3";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiServer, type ApiServerOptions } from "../../src/api/server.js";
import { migrate } from "../../src/db/migrate.js";

export const CIRCLE = "agents-main";
export const CONTRACT = "x207-circle.near";
/** Account names of fixture FX-AG6: `<name>.x207-circle.near`. */
export const AGENTS = ["cleaner", "gpu", "image", "scraper", "summarizer", "translator"] as const;
export const acct = (name: string): string => `${name}.x207-circle.near`;

export const ISO_NS = (iso: string): bigint => BigInt(Date.parse(iso)) * 1_000_000n;

/** Empty, migrated D9 with the `agents-main` circle and the indexer cursor. */
export function seedCircle(db: Database.Database, lastBlock = 171234567): void {
  migrate(db);
  db.prepare("INSERT INTO circles (circle_id, contract_id, network) VALUES (?, ?, ?)").run(
    CIRCLE,
    CONTRACT,
    `x207:${CIRCLE}`,
  );
  db.prepare(
    `INSERT INTO indexer_cursor (name, contract_id, start_block_height, last_block_height, last_block_hash,
       last_block_timestamp_ns, head_block_height, lag_blocks, rpc_endpoint, updated_at)
     VALUES (?, ?, 1, ?, 'bh', 1, ?, 0, 'https://rpc.mainnet.fastnear.com', 1)`,
  ).run(CONTRACT, CONTRACT, lastBlock, lastBlock);
}

export interface MemberSeed {
  name: string;
  status?: string;
  stake?: bigint | number;
  limit?: bigint | number;
  debt?: bigint | number;
  settledHistory?: bigint | number;
  joinedAt?: string;
  exitRequestedEpoch?: number | null;
}

export function seedMember(db: Database.Database, m: MemberSeed): void {
  db.prepare(
    `INSERT INTO members (circle_id, account_id, pubkey_voucher, terms_hash, stake, credit_limit,
       outstanding_debt, status, settled_history, joined_at_ns, exit_requested_epoch, updated_block)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    CIRCLE,
    acct(m.name),
    `ed25519:${m.name}`,
    `terms-${m.name}`,
    BigInt(m.stake ?? 100_000_000),
    BigInt(m.limit ?? 80_000_000),
    BigInt(m.debt ?? 0),
    m.status ?? "active",
    BigInt(m.settledHistory ?? 0),
    ISO_NS(m.joinedAt ?? "2026-11-03T08:12:44Z"),
    m.exitRequestedEpoch ?? null,
  );
}

/** Six FX-AG6 agents with FX-E42 `outstanding_debt` before commit (D9 up to L19). */
export function seedAg6(db: Database.Database, upTo: "L19" | "L29" = "L19"): void {
  const debt: Record<string, number> = {
    translator: 30_000_000,
    summarizer: 30_000_000,
    image: 30_000_000,
    scraper: 50_000_000,
    cleaner: 30_000_000,
    gpu: 20_000_000,
  };
  for (const name of AGENTS) {
    if (upTo === "L19") {
      seedMember(db, { name, debt: debt[name] as number });
    } else if (name === "scraper") {
      seedMember(db, { name, status: "suspended", stake: 65_000_000, limit: 0, debt: 0 });
    } else {
      seedMember(db, { name, debt: 0 });
    }
  }
}

export interface EpochSeed {
  epoch: number;
  phase: "open" | "clearing" | "payment_window" | "finalized";
  cutoffAt?: string;
  closedAt?: string;
  proposalDeadline?: string;
  committedAt?: string;
  paymentDeadline?: string;
  finalizedAt?: string;
  edgeCount?: number;
  totalObligation?: number;
  cleared?: number;
}

export function seedEpoch(db: Database.Database, e: EpochSeed): void {
  const ns = (iso?: string) => (iso ? ISO_NS(iso) : null);
  db.prepare(
    `INSERT INTO epochs (circle_id, epoch, phase, cutoff_at_ns, closed_at_ns, proposal_deadline_ns,
       committed_at_ns, payment_deadline_ns, finalized_at_ns, edge_count, total_obligation, cleared_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    CIRCLE,
    e.epoch,
    e.phase,
    ns(e.cutoffAt),
    ns(e.closedAt),
    ns(e.proposalDeadline),
    ns(e.committedAt),
    ns(e.paymentDeadline),
    ns(e.finalizedAt),
    e.edgeCount ?? null,
    e.totalObligation === undefined ? null : BigInt(e.totalObligation),
    BigInt(e.cleared ?? 0),
  );
}

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function listen(options: ApiServerOptions): Promise<TestServer> {
  const server: Server = createApiServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
