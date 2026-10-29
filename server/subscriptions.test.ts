import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import * as store from "./store.ts";
import { monthSummary } from "./reports.ts";
import { chargeDebits, debitDate } from "./subscriptions.ts";

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
  assert.equal(chargeDebits(db, "2026-10-26"), 0);
  assert.equal(chargeDebits(db, "2026-11-11"), 0);
  assert.equal(chargeDebits(db, "2026-11-12"), 1);
  assert.equal(chargeDebits(db, "2026-11-20"), 0);

  const [t] = expenses(db);
  assert.equal(t.date, "2026-11-12");
  assert.equal(t.amountCents, 1399);
  assert.equal(t.description, "Netflix");
  assert.equal(t.paid, true);
  const cat = store.listCategories(db).find((c) => c.id === t.categoryId)!;
  assert.equal(cat.name, "Subscrições");

  // A deleted debit stays deleted; the next month still comes.
  store.deleteTransaction(db, t.id);
  assert.equal(chargeDebits(db, "2026-12-01"), 0);
  assert.equal(chargeDebits(db, "2027-01-15"), 2); // December and January
  assert.deepEqual(expenses(db).map((e) => e.date), ["2027-01-12", "2026-12-12"]);

  // Changing the day doesn't charge January a second time.
  store.savePlanItem(db, { id, section: "subscription", name: "Netflix", amountCents: 1399, month: null, sort: 0, debitDay: 20 }, "2027-01-15");
  assert.equal(chargeDebits(db, "2027-01-31"), 0);
  assert.equal(chargeDebits(db, "2027-02-20"), 1);
});

test("an expense with the same name already that month counts as the debit", () => {
  const db = openDb(":memory:");
  store.savePlanItem(
    db,
    { section: "subscription", name: "Spotify", amountCents: 1099, month: null, sort: 0, debitDay: 28 },
    "2026-10-26",
  );
  store.saveTransaction(db, { kind: "expense", date: "2026-10-27", amountCents: 1099, description: "spotify ", categoryId: null });
  assert.equal(chargeDebits(db, "2026-10-28"), 0);
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

  chargeDebits(db, "2026-11-15");
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

const loan = (db: ReturnType<typeof openDb>, extra: Partial<Parameters<typeof store.saveLoan>[1]> = {}, today = "2026-10-29") =>
  store.saveLoan(
    db,
    { name: "Credito carro", principalCents: 800000, monthlyCents: 12500, paidOff: false, mortgage: false, sort: 0, amortizations: [], ...extra },
    today,
  );

test("a bank loan's payment is added as a paid expense on its debit day, from its account and category", () => {
  const db = openDb(":memory:");
  const montepio = store.saveAccount(db, { name: "Montepio", openingCents: 100000, isDefault: false, sort: 1, archived: false });
  const creditos = store.ensureCategory(db, "expense", "Creditos");
  const id = loan(db, { accountId: montepio, categoryId: creditos, debitDay: 8 });

  // Setting the day on October 29 doesn't backfill October 8.
  assert.equal(chargeDebits(db, "2026-10-29"), 0);
  assert.equal(chargeDebits(db, "2026-11-07"), 0);
  assert.equal(chargeDebits(db, "2026-11-08"), 1);
  assert.equal(chargeDebits(db, "2026-11-30"), 0);

  const [t] = expenses(db);
  assert.deepEqual([t.date, t.amountCents, t.description, t.paid, t.categoryId, t.accountId], ["2026-11-08", 12500, "Credito carro", true, creditos, montepio]);
  const balance = store.listAccounts(db).find((a) => a.id === montepio)!.balanceCents;
  assert.equal(balance, 100000 - 12500);

  // Deleted stays deleted; a paid-off loan is no longer debited.
  store.deleteTransaction(db, t.id);
  assert.equal(chargeDebits(db, "2026-12-08"), 1);
  store.saveLoan(db, { id, name: "Credito carro", principalCents: 800000, monthlyCents: 12500, paidOff: true, mortgage: false, sort: 0, amortizations: [] });
  assert.equal(chargeDebits(db, "2027-01-31"), 0);
  assert.equal(expenses(db).length, 1);
});

test("a loan without a category is paid in the credit category and tied to it", () => {
  const db = openDb(":memory:");
  const id = loan(db, { debitDay: 30 });
  assert.equal(chargeDebits(db, "2026-10-30"), 1);
  const [t] = expenses(db);
  const cat = store.listCategories(db).find((c) => c.id === t.categoryId)!;
  assert.equal(cat.name, "Créditos");
  assert.equal(store.listLoans(db).find((l) => l.id === id)!.categoryId, cat.id);
});

test("the bank's own line a few days off counts as the loan's debit", () => {
  const db = openDb(":memory:");
  loan(db, { debitDay: 10, monthlyCents: 4200, name: "Telemóvel" });
  // Typed in (or imported) two days early, with the bank's description.
  store.saveTransaction(db, { kind: "expense", date: "2026-11-08", amountCents: 4200, description: "PRESTACAO 0042", categoryId: null });
  assert.equal(monthSummary(db, "2026-11", "2026-11-09").upcoming.length, 0);
  assert.equal(chargeDebits(db, "2026-11-10"), 0);
  assert.equal(expenses(db).length, 1);
});

test("loan debits still to come show on the budget, setting the day on the Plan keeps the start", () => {
  const db = openDb(":memory:");
  const id = loan(db, {}, "2026-10-01");
  store.setLoanDebitDay(db, id, 20, "2026-10-01");
  const s = monthSummary(db, "2026-11", "2026-11-02");
  assert.deepEqual(s.upcoming.map((d) => [d.source, d.name, d.date]), [["loan", "Credito carro", "2026-11-20"]]);
  // Changing the day later doesn't charge a month twice.
  assert.equal(chargeDebits(db, "2026-11-20"), 2); // October 20 and November 20
  store.setLoanDebitDay(db, id, 25, "2026-11-21");
  assert.equal(chargeDebits(db, "2026-11-30"), 0);
});
