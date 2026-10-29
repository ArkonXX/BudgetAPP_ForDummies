import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import * as store from "./store.ts";
import { monthSummary, planGrid } from "./reports.ts";
import { closeMonth, CloseError, reopenMonth } from "./month-close.ts";

// Budget months start on payday: October 2026 runs from Wed 30 Sep to Fri 30 Oct.
const TODAY = "2026-10-31"; // already November's budget month

function setup() {
  const db = openDb(":memory:");
  const salary = store.upsertCategory(db, { kind: "income", name: "Salário", plannedCents: 0, sort: 0, archived: false }).id;
  const food = store.upsertCategory(db, { kind: "expense", name: "Supermercado", plannedCents: 0, sort: 0, archived: false }).id;
  store.saveTransaction(db, { kind: "income", date: "2026-09-30", amountCents: 150000, description: "", categoryId: salary });
  store.saveTransaction(db, { kind: "expense", date: "2026-10-05", amountCents: 100000, description: "", categoryId: food });
  return { db, food };
}

test("closing a month keeps its balance, checks the accounts against the bank and moves nothing", () => {
  const { db } = setup();
  const accountBefore = store.listAccounts(db)[0].balanceCents;
  assert.equal(monthSummary(db, "2026-10", TODAY).canClose, true);
  assert.equal(monthSummary(db, "2026-11", TODAY).previousOpen, "2026-10");

  const account = store.listAccounts(db)[0].id;
  const c = closeMonth(db, "2026-10", [{ accountId: account, bankCents: accountBefore + 500 }], TODAY);
  assert.equal(c.balanceCents, 50000);
  assert.deepEqual(c.adjustments.map((a) => a.amountCents), [500]);

  const oct = monthSummary(db, "2026-10", TODAY);
  assert.equal(oct.balanceCents, 50000);
  assert.equal(oct.canClose, false);
  assert.deepEqual(oct.close, c);
  // The next month starts from its own entries; the money is already in the accounts.
  const nov = monthSummary(db, "2026-11", TODAY);
  assert.equal(nov.balanceCents, 0);
  assert.equal(nov.previousOpen, null);
  assert.equal(planGrid(db, "2026-11", 1, TODAY).months[0].endCents, 0);
  // Only the bank check changes the account; the leftover stays where it is.
  assert.equal(store.listAccounts(db)[0].balanceCents, accountBefore + 500);
  assert.equal(store.listMovements(db).length, 0);

  // Reopening unlocks the month; the balance still matches the bank.
  reopenMonth(db, "2026-10");
  assert.equal(monthSummary(db, "2026-10", TODAY).close, null);
  assert.equal(store.listAccounts(db)[0].balanceCents, accountBefore + 500);
});

test("only past months can be closed, and any closed month can be reopened", () => {
  const { db } = setup();
  assert.throws(() => closeMonth(db, "2026-11", [], TODAY), CloseError);
  closeMonth(db, "2026-09", [], TODAY);
  closeMonth(db, "2026-10", [], TODAY);
  assert.throws(() => closeMonth(db, "2026-10", [], TODAY), CloseError);
  reopenMonth(db, "2026-09");
  assert.throws(() => reopenMonth(db, "2026-09"), CloseError);
});

test("reopening a month closed by the old version keeps its pot money and balance adjustments", () => {
  const { db } = setup();
  const account = store.listAccounts(db)[0];
  const pot = store.savePot(db, { name: "Férias", goalCents: 0, sort: 0 });
  const movement = store.saveMovement(db, { potId: pot, date: "2026-10-29", amountCents: 20000, place: "", note: "", opening: false });
  db.prepare("INSERT INTO month_closes (month, closed_at, balance_cents, action, pot_id, pot_cents, movement_id, carry_cents) VALUES ('2026-10', ?, 50000, 'pot', ?, 20000, ?, 30000)").run(TODAY, pot, movement);
  db.prepare("INSERT INTO account_adjustments (account_id, date, amount_cents, close_month) VALUES (?, ?, 500, '2026-10')").run(account.id, TODAY);
  // The old carry no longer counts in November.
  assert.equal(monthSummary(db, "2026-11", TODAY).balanceCents, 0);
  reopenMonth(db, "2026-10");
  assert.equal(store.listPots(db)[0].balanceCents, 20000);
  assert.equal(store.listAccounts(db)[0].balanceCents, account.balanceCents + 500);
});

test("entries dated in a closed month can't be added, changed or deleted", async () => {
  const { db, food } = setup();
  const server = createApp(db, { password: "pw", secureCookie: false }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const headers = { "Content-Type": "application/json", "X-Budget-App": "1" };
  try {
    const login = await fetch(`${base}/login`, { method: "POST", headers, body: JSON.stringify({ password: "pw" }) });
    const authed = { ...headers, Cookie: login.headers.get("set-cookie")!.split(";")[0] };
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: authed, body: JSON.stringify(body) });
    const expense = (date: string, paid = true) => post("/transactions", { kind: "expense", date, amountCents: 100, categoryId: food, paid });

    // September is a past month whatever day the test runs.
    store.saveTransaction(db, { kind: "expense", date: "2026-09-10", amountCents: 100, description: "", categoryId: food });
    const closed = await post("/month-close", { month: "2026-09" });
    assert.equal(closed.status, 200);

    const refused = await expense("2026-09-10");
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "month_closed" });
    assert.equal((await post("/month-plans", { month: "2026-09", categoryId: food, cents: 1 })).status, 409);
    assert.equal((await post("/savings/movements", { potId: 1, date: "2026-09-01", amountCents: 1 })).status, 409);
    const old = store.listTransactions(db, { kind: "expense", from: "2026-09-01", to: "2026-09-30" })[0];
    assert.equal((await fetch(`${base}/transactions/${old.id}`, { method: "DELETE", headers: authed })).status, 409);

    // An unpaid expense doesn't count in its month, and later months stay open.
    const unpaid = await expense("2026-09-10", false);
    assert.equal(unpaid.status, 200);
    const { id } = (await unpaid.json()) as { id: number };
    assert.equal((await post(`/transactions/${id}/pay`, { date: "2026-09-12" })).status, 409);
    assert.equal((await post(`/transactions/${id}/pay`, { date: "2026-10-02" })).status, 200);

    assert.equal((await fetch(`${base}/month-close/2026-09`, { method: "DELETE", headers: authed })).status, 200);
    assert.equal((await expense("2026-09-10")).status, 200);
  } finally {
    server.close();
  }
});
