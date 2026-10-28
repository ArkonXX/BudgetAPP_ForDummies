import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import * as store from "./store.ts";
import { monthSummary } from "./reports.ts";
import { installmentDate } from "../shared/period.ts";

test("installment due dates", () => {
  assert.equal(installmentDate("2026-01-31", 1, null), "2026-02-28");
  assert.equal(installmentDate("2026-01-31", 2, null), "2026-03-31");
  assert.equal(installmentDate("2026-11-15", 2, null), "2027-01-15");
  assert.equal(installmentDate("2026-10-26", 1, 30), "2026-11-25");
  assert.equal(installmentDate("2026-10-26", 2, 14), "2026-11-23");
});

test("a purchase in 3 installments", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1 });
  const cat = store.ensureCategory(db, "expense", "Lazer");
  const plan = store.createInstallmentPlan(db, {
    name: "Klarna - Loja",
    totalCents: 10000,
    count: 3,
    everyDays: null,
    categoryId: cat,
    accountId: null,
    firstDate: "2026-10-26",
    firstPaid: true,
  });
  assert.deepEqual(
    plan.installments.map((i) => [i.date, i.amountCents, i.paid, i.installment?.seq, i.installment?.count]),
    [
      ["2026-10-26", 3333, true, 1, 3],
      ["2026-11-26", 3333, false, 2, 3],
      ["2026-12-26", 3334, false, 3, 3],
    ],
  );
  // No account picked: the installments belong to the default account.
  const main = store.listAccounts(db).find((a) => a.isDefault)!;
  assert.ok(plan.installments.every((i) => i.accountId === main.id));
  assert.equal(plan.paidCents, 3333);
  assert.equal(plan.remainingCents, 6667);
  assert.equal(plan.nextDue, "2026-11-26");

  // Only the paid one counts in October; November lists the second as still to pay.
  assert.equal(monthSummary(db, "2026-10").totalExpenseCents, 3333);
  const nov = monthSummary(db, "2026-11");
  assert.equal(nov.totalExpenseCents, 0);
  assert.deepEqual(nov.pending.map((p) => p.installment?.seq), [2]);

  store.payTransaction(db, plan.installments[1].id, "2026-11-20");
  assert.equal(monthSummary(db, "2026-11").totalExpenseCents, 3333);
  assert.equal(store.listInstallmentPlans(db)[0].remainingCents, 3334);

  store.deleteInstallmentPlan(db, plan.id);
  assert.equal(store.listInstallmentPlans(db).length, 0);
  assert.equal(store.listTransactions(db, {}).length, 0);
});

const klarna = (db: ReturnType<typeof openDb>, cat: number | null) =>
  store.createInstallmentPlan(db, {
    name: "Ferias Verao",
    totalCents: 120000,
    count: 3,
    everyDays: null,
    categoryId: cat,
    accountId: null,
    firstDate: "2026-09-26",
    firstPaid: true,
  });

test("deleting an installment from entries keeps it owed", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1 });
  const plan = klarna(db, store.ensureCategory(db, "expense", "Ferias"));
  const [first, second, third] = plan.installments;
  store.payTransaction(db, second.id, "2026-10-26");

  // A paid installment goes back to still to pay, on its due date.
  assert.equal(store.deleteTransaction(db, second.id), "unpaid");
  // An unpaid one is not deleted at all: the purchase is deleted from Loans.
  assert.equal(store.deleteTransaction(db, third.id), "installment");
  const after = store.listInstallmentPlans(db)[0];
  assert.deepEqual(
    after.installments.map((i) => [i.id, i.date, i.paid]),
    [
      [first.id, "2026-09-26", true],
      [second.id, "2026-10-26", false],
      [third.id, "2026-11-26", false],
    ],
  );
  assert.equal(after.remainingCents, 120000 - 40000);

  // Ordinary entries are still deleted.
  const t = store.saveTransaction(db, { kind: "expense", date: "2026-10-01", amountCents: 100, description: "", categoryId: null });
  assert.equal(store.deleteTransaction(db, t.id), "deleted");
  assert.equal(store.listTransactions(db, { from: "2026-10-01", to: "2026-10-02" }).length, 0);
});

test("installments deleted before the fix are put back as still to pay", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-"));
  try {
    const path = join(dir, "budget.db");
    let db = openDb(path);
    const plan = klarna(db, null);
    // What an older version left behind: no first date, installment 2 deleted, 3 paid late.
    db.prepare("UPDATE installment_plans SET first_date = NULL").run();
    db.prepare("DELETE FROM transactions WHERE id = ?").run(plan.installments[1].id);
    db.prepare("UPDATE transactions SET date = '2026-12-02' WHERE id = ?").run(plan.installments[2].id);
    store.payTransaction(db, plan.installments[2].id, "2026-12-02");
    db.close();

    db = openDb(path);
    const [restored] = store.listInstallmentPlans(db);
    assert.deepEqual(
      restored.installments.map((i) => [i.installment?.seq, i.date, i.amountCents, i.paid]),
      [
        [1, "2026-09-26", 40000, true],
        [2, "2026-10-26", 40000, false],
        [3, "2026-12-02", 40000, true],
      ],
    );
    assert.equal(restored.remainingCents, 40000);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the budget table shows what is still to pay, and money paid back to people in the month it is paid", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1 });
  const ferias = store.ensureCategory(db, "expense", "Ferias");
  const gym = store.ensureCategory(db, "expense", "Subscrições");
  klarna(db, ferias);
  store.saveTransaction(db, { kind: "expense", date: "2026-10-15", amountCents: 2100, description: "Ginásio", categoryId: gym, paid: false });
  store.saveTransaction(db, { kind: "expense", date: "2026-11-03", amountCents: 500, description: "Ginásio", categoryId: gym });
  store.savePersonalLoan(db, { person: "Ana", direction: "borrowed", date: "2026-10-10", amountCents: 20000, dueDate: null, note: "" });
  store.savePersonalLoan(db, { person: "Ana", direction: "lent", date: "2026-10-12", amountCents: 5000, dueDate: null, note: "" });
  store.savePersonalLoan(db, { person: "Rui", direction: "borrowed", date: "2026-11-20", amountCents: 3000, dueDate: null, note: "" });
  store.savePersonalLoan(db, { person: "Zé", direction: "lent", date: "2026-10-01", amountCents: 9000, dueDate: null, note: "" });
  store.payPerson(db, { person: "Ana", direction: "borrowed", date: "2026-11-02", amountCents: 8000, note: "" });
  store.payPerson(db, { person: "Zé", direction: "lent", date: "2026-11-02", amountCents: 1000, note: "" });

  const nov = monthSummary(db, "2026-11", "2026-11-05");
  const line = (id: number) => nov.expenses.find((e) => e.categoryId === id)!;
  // Installment 2 (due in October, carried over) and 3, plus the gym bill carried over.
  assert.equal(line(ferias).toPayCents, 40000 + 40000);
  assert.equal(line(gym).actualCents, 500);
  assert.equal(line(gym).toPayCents, 2100);
  assert.equal(nov.totalExpenseCents, 500);
  // Only what I paid back counts, in November; money borrowed or paid back to me doesn't.
  assert.deepEqual(nov.repaid, [{ person: "Ana", cents: 8000 }]);
  assert.equal(nov.repaidCents, 8000);
  assert.equal(nov.balanceCents, -500 - 8000);
  // October: the money was borrowed, nothing paid back yet, so it counts nowhere.
  const oct = monthSummary(db, "2026-10", "2026-10-26");
  assert.deepEqual(oct.repaid, []);
  assert.equal(oct.balanceCents, 0);
});
