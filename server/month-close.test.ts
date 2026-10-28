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
  const account = store.listAccounts(db)[0].id;
  const salary = store.upsertCategory(db, { kind: "income", name: "Salário", plannedCents: 0, sort: 0, archived: false }).id;
  const food = store.upsertCategory(db, { kind: "expense", name: "Supermercado", plannedCents: 0, sort: 0, archived: false }).id;
  store.saveTransaction(db, { kind: "income", date: "2026-09-30", amountCents: 150000, description: "", categoryId: salary });
  store.saveTransaction(db, { kind: "expense", date: "2026-10-05", amountCents: 100000, description: "", categoryId: food });
  const pot = store.savePot(db, { name: "Férias", goalCents: 0, sort: 0 });
  return { db, account, food, pot };
}

const close = (db: ReturnType<typeof openDb>, input: Partial<Parameters<typeof closeMonth>[1]>) =>
  closeMonth(db, { month: "2026-10", action: "carry", potId: null, potCents: 0, accountId: null, balances: [], ...input }, TODAY);

test("a leftover goes partly into a pot and the rest on to the next month; balances follow the bank", () => {
  const { db, account, pot } = setup();
  const before = monthSummary(db, "2026-10", TODAY);
  assert.equal(before.balanceCents, 50000);
  assert.equal(before.canClose, true);
  assert.equal(monthSummary(db, "2026-11", TODAY).previousOpen, "2026-10");

  const c = close(db, { action: "pot", potId: pot, potCents: 30000, accountId: account, balances: [{ accountId: account, bankCents: 50500 }] });
  assert.equal(c.balanceCents, 50000);
  assert.equal(c.potCents, 30000);
  assert.equal(c.carryCents, 20000);
  assert.deepEqual(c.adjustments.map((a) => a.amountCents), [500]);

  // The deposit is on October's last day, so it counts as October's savings.
  const oct = monthSummary(db, "2026-10", TODAY);
  assert.equal(oct.savingsCents, 30000);
  assert.equal(oct.balanceCents, 20000);
  assert.equal(oct.canClose, false);
  assert.equal(oct.canReopen, true);
  const nov = monthSummary(db, "2026-11", TODAY);
  assert.equal(nov.carriedInCents, 20000);
  assert.equal(nov.balanceCents, 20000);
  assert.equal(nov.previousOpen, null);
  assert.equal(planGrid(db, "2026-11", 1, TODAY).months[0].endCents, 20000);
  assert.equal(store.listPots(db)[0].balanceCents, 30000);
  assert.equal(store.listAccounts(db)[0].balanceCents, 50500 - 30000);

  reopenMonth(db, "2026-10");
  assert.equal(store.listPots(db)[0].balanceCents, 0);
  assert.equal(store.listAccounts(db)[0].balanceCents, 50000);
  assert.equal(monthSummary(db, "2026-11", TODAY).carriedInCents, 0);
  assert.equal(monthSummary(db, "2026-10", TODAY).balanceCents, 50000);
});

test("a shortfall is carried, or covered from a pot that has enough", () => {
  const { db, food, pot } = setup();
  store.saveTransaction(db, { kind: "expense", date: "2026-10-20", amountCents: 60000, description: "", categoryId: food });
  store.saveMovement(db, { potId: pot, date: "2026-09-01", amountCents: 5000, place: "", note: "", opening: false });
  assert.throws(() => close(db, { action: "pot", potId: pot, potCents: 10000 }), CloseError);
  const c = close(db, { action: "pot", potId: pot, potCents: 4000 });
  assert.equal(c.balanceCents, -10000);
  assert.equal(c.carryCents, -6000);
  assert.equal(store.listPots(db)[0].balanceCents, 1000);
  assert.equal(monthSummary(db, "2026-11", TODAY).balanceCents, -6000);
});

test("only past months can be closed, and only the last closed month reopened", () => {
  const { db } = setup();
  assert.throws(() => close(db, { month: "2026-11" }), CloseError);
  close(db, { month: "2026-09", action: "none" });
  close(db, {});
  assert.throws(() => close(db, {}), CloseError);
  assert.throws(() => reopenMonth(db, "2026-09"), CloseError);
  assert.equal(monthSummary(db, "2026-09", TODAY).canReopen, false);
  reopenMonth(db, "2026-10");
  reopenMonth(db, "2026-09");
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
    const closed = await post("/month-close", { month: "2026-09", action: "carry", balances: [] });
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
