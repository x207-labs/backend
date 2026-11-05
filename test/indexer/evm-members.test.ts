// BE-093: members whose id is a lower-case 0x address (EVM agents, contract 0.0.14 `join_evm`) go through the indexer and the read API like any member. The contract emits the same
// events for them (`member_joined` with a placeholder voucher key, `stake_added`, `voucher_registered`), so nothing in the read model is special; this test keeps it that way.
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { Indexer } from "../../src/indexer/indexer.js";
import { acct, ArrayBlockSource, block, CONTRACT, eventLog, nsOf } from "../helpers/fx-log42.js";
import { listen, type TestServer } from "../helpers/d9-fixtures.js";

const CIRCLE = "agents-main";
const EVM = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const PLACEHOLDER = "ed25519:11111111111111111111111111111111";

describe("BE-093 EVM members in the read model", () => {
  let db: Database.Database;
  let srv: TestServer | undefined;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
    db.close();
  });

  const join = (id: string, key: string) => eventLog("member_joined", { account_id: id, pubkey_voucher: key, terms_hash: "a".repeat(64), status: "pending", joined_at: nsOf("2026-11-09T08:00:00Z") });
  const stake = (id: string) => eventLog("stake_added", { account_id: id, sender_id: "evmrelayer.testnet", amount: "50000000", stake: "50000000", limit: "40000000", status: "active" });

  async function ingest(): Promise<void> {
    const seller = acct("summarizer");
    const ix = new Indexer({
      db, source: new ArrayBlockSource([
        block(1000, { logs: [join(EVM, PLACEHOLDER)] }, { logs: [join(seller, "ed25519:summarizer")] }),
        block(1001, { logs: [stake(EVM)] }, { logs: [stake(seller)] }),
        block(1002, { logs: [eventLog("voucher_registered", { payer: EVM, payee: seller, epoch: 1, seq: 1, cumulative_amount: "20000", delta: "20000", obligation: "20000", outstanding_debt: "20000", mode: "cumulative" })] }),
      ]),
      circleId: CIRCLE, contractId: CONTRACT, startBlock: 1000,
    });
    await ix.bootstrap();
    await ix.drain();
  }

  it("TC-BE-093-01 join, stake and a voucher of an EVM member are stored under the 0x id", async () => {
    await ingest();
    expect(db.prepare("SELECT account_id, status, stake, credit_limit, outstanding_debt, pubkey_voucher FROM members WHERE account_id = ?").get(EVM)).toEqual({
      account_id: EVM, status: "active", stake: 50_000_000, credit_limit: 40_000_000, outstanding_debt: 20_000, pubkey_voucher: PLACEHOLDER,
    });
    expect(db.prepare("SELECT debtor, creditor, seq, cumulative_amount FROM obligations").all()).toEqual([{ debtor: EVM, creditor: acct("summarizer"), seq: 1, cumulative_amount: 20_000 }]);
  });

  it("TC-BE-093-02 the read API lists and returns the EVM member by its 0x id", async () => {
    await ingest();
    srv = await listen({ db });
    const list = await (await fetch(`${srv.url}/x207/circles/${CIRCLE}/members`)).json();
    expect(list.items.map((m: { account: string }) => m.account)).toContain(EVM);
    const res = await fetch(`${srv.url}/x207/circles/${CIRCLE}/members/${EVM}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ account: EVM, status: "active", stake: "50000000", limit: "40000000", outstandingDebt: "20000", pubkeyVoucher: PLACEHOLDER });
  });
});
