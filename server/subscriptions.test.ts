import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import * as store from "./store.ts";
import { monthSummary } from "./reports.ts";
import { chargeSubscriptions, debitDate } from "./subscriptions.ts";

const expenses = (db: ReturnType<typeof openDb>) => store.listTransactions(db, { kind: "expense" });

test("debit day is clamped to the end of short months", () => {
  assert.equal(debitDate(31, "2026-02"), "2026-02-28");
  assert.equal(debitDate(31, "2026-03"), "2026-03-31");
  assert.equal(debitDate(5, "2026-11"), "2026-11-05");
});

test("a subscription is added as a paid expense on its debit day, once a month", () => {
  const db = openDb(":memory:");
  const id = store.savePlanItem(
    db,
    { section: "subscription", name: "Netflix", amountCents: 1399, month: null, sort: 0, debitDay: 12 },
    "2026-10-26",
  );

  // Setting the day doesn't backfill October 12, which is already past.
  assert.equal(chargeSubscriptions(db, "2026-10-26"), 0);
  assert.equal(chargeSubscriptions(db, "2026-11-11"), 0);
  assert.equal(chargeSubscriptions(db, "2026-11-12"), 1);
  assert.equal(chargeSubscriptions(db, "2026-11-20"), 0);

  const [t] = expenses(db);
  assert.equal(t.date, "2026-11-12");
  assert.equal(t.amountCents, 1399);
  assert.equal(t.description, "Netflix");
  assert.equal(t.paid, true);
  const cat = store.listCategories(db).find((c) => c.id === t.categoryId)!;
  assert.equal(cat.name, "Subscrições");

  // A deleted debit stays deleted; the next month still comes.
  store.deleteTransaction(db, t.id);
  assert.equal(chargeSubscriptions(db, "2026-12-01"), 0);
  assert.equal(chargeSubscriptions(db, "2027-01-15"), 2); // December and January
  assert.deepEqual(expenses(db).map((e) => e.date), ["2027-01-12", "2026-12-12"]);

  // Changing the day doesn't charge January a second time.
  store.savePlanItem(db, { id, section: "subscription", name: "Netflix", amountCents: 1399, month: null, sort: 0, debitDay: 20 }, "2027-01-15");
  assert.equal(chargeSubscriptions(db, "2027-01-31"), 0);
  assert.equal(chargeSubscriptions(db, "2027-02-20"), 1);
});

test("an expense with the same name already that month counts as the debit", () => {
  const db = openDb(":memory:");
  store.savePlanItem(
    db,
    { section: "subscription", name: "Spotify", amountCents: 1099, month: null, sort: 0, debitDay: 28 },
    "2026-10-26",
  );
  store.saveTransaction(db, { kind: "expense", date: "2026-10-27", amountCents: 1099, description: "spotify ", categoryId: null });
  assert.equal(chargeSubscriptions(db, "2026-10-28"), 0);
  assert.equal(expenses(db).length, 1);
});

test("the budget shows the debits still to come this month", () => {
  const db = openDb(":memory:");
  const account = store.saveAccount(db, { name: "Revolut", openingCents: 0, isDefault: false, sort: 1, archived: false });
  const cat = store.ensureCategory(db, "expense", "Lazer");
  store.savePlanItem(
    db,
    { section: "subscription", name: "Disney+", amountCents: 899, month: null, sort: 0, debitDay: 15, categoryId: cat, accountId: account },
    "2026-10-01",
  );
  store.savePlanItem(db, { section: "subscription", name: "Sem dia", amountCents: 500, month: null, sort: 1 }, "2026-10-01");

  // November runs from payday Fri 2026-10-30 to Mon 2026-11-30.
  const before = monthSummary(db, "2026-11", "2026-11-02");
  assert.deepEqual(before.upcoming.map((d) => [d.name, d.date]), [["Disney+", "2026-11-15"]]);
  assert.equal(before.upcomingCents, 899);

  chargeSubscriptions(db, "2026-11-15");
  const after = monthSummary(db, "2026-11", "2026-11-15");
  assert.equal(after.upcoming.length, 0);
  assert.equal(after.expenses.find((e) => e.name === "Lazer")!.actualCents, 899);
  assert.equal(expenses(db)[0].accountId, account);
});

test("upcoming debits carry the category and the account they will use", () => {
  const db = openDb(":memory:");
  const subs = store.ensureCategory(db, "expense", "Subscrições");
  store.savePlanItem(db, { section: "subscription", name: "Ginásio", amountCents: 2100, month: null, sort: 0, debitDay: 25 }, "2026-10-26");
  const [d] = monthSummary(db, "2026-11", "2026-10-26").upcoming;
  const main = store.listAccounts(db).find((a) => a.isDefault)!;
  assert.deepEqual([d.date, d.categoryId, d.accountId], ["2026-11-25", subs, main.id]);
});
