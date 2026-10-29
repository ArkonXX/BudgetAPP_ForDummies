import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import * as store from "./store.ts";
import { overview } from "./overview.ts";

test("overview: running totals, projection and suggestions", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1, plannedSavingsCents: 0 });
  const cat = (name: string, plannedCents: number) =>
    store.upsertCategory(db, { kind: "expense", name, plannedCents, sort: 0, archived: false }).id;
  const food = cat("Supermercado", 30000);
  const fun = cat("Lazer", 5000);
  const fuel = cat("Combustível", 15000);
  const spend = (date: string, amountCents: number, categoryId: number) =>
    store.saveTransaction(db, { kind: "expense", date, amountCents, description: "", categoryId });

  // Three earlier months: 100 € of food by day 10, 100 € more later, 100 € of fuel early.
  for (const m of ["07", "08", "09"]) {
    spend(`2026-${m}-05`, 10000, food);
    spend(`2026-${m}-20`, 10000, food);
    spend(`2026-${m}-03`, 10000, fuel);
  }
  // This month, by day 10: food well above usual, fun over budget, fuel well below usual.
  spend("2026-10-02", 18000, food);
  spend("2026-10-04", 6000, fun);
  spend("2026-10-06", 2000, fuel);
  // An unpaid expense stays out of every total until it is paid.
  store.saveTransaction(db, { kind: "expense", date: "2026-10-07", amountCents: 50000, description: "", categoryId: fun, paid: false });
  store.savePlanItem(db, { section: "annual", name: "Seguro", amountCents: 24000, month: 11, sort: 0 });

  const o = overview(db, "2026-10", "2026-10-10");
  assert.equal(o.days, 31);
  assert.equal(o.elapsedDays, 10);
  assert.equal(o.cumulativeCents.length, 10);
  assert.equal(o.cumulativeCents[9], 26000);
  assert.equal(o.previousCumulativeCents.length, 30);
  assert.equal(o.previousCumulativeCents[29], 30000);
  // Spent so far plus the usual 100 € spent after day 10.
  assert.equal(o.projectedExpenseCents, 36000);
  assert.deepEqual(
    o.history.map((h) => h.expenseCents),
    [0, 0, 30000, 30000, 30000, 26000],
  );

  const byType = Object.fromEntries(o.tips.map((t) => [t.type, t]));
  assert.equal(o.tips[0].type, "overBudget");
  assert.deepEqual([byType.overBudget.name, byType.overBudget.amountCents], ["Lazer", 6000]);
  assert.deepEqual([byType.aboveUsual.name, byType.aboveUsual.compareCents], ["Supermercado", 10000]);
  assert.deepEqual([byType.belowUsual.name, byType.belowUsual.amountCents], ["Combustível", 2000]);
  // A yearly Plan item due next month is something to do, not a suggestion.
  const annual = o.todo.find((t) => t.type === "annualNext");
  assert.deepEqual([annual?.name, annual?.amountCents], ["Seguro", 24000]);

  // A month in the future has nothing elapsed and no suggestions.
  const future = overview(db, "2026-12", "2026-10-10");
  assert.equal(future.elapsedDays, 0);
  assert.equal(future.projectedExpenseCents, null);
  assert.equal(future.tips.length, 0);
});

test("overview: free to spend, things to do and net worth", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1, plannedSavingsCents: 10000 });
  const main = store.listAccounts(db)[0].id;
  store.saveAccount(db, { id: main, name: "Montepio", openingCents: 100000, isDefault: true, sort: 0, archived: false });
  const rev = store.saveAccount(db, { name: "Revolut", openingCents: 0, isDefault: false, sort: 1, archived: false });
  const cat = (name: string, plannedCents: number, group: "fixed" | "variable") =>
    store.upsertCategory(db, { kind: "expense", name, plannedCents, sort: 0, archived: false, group }).id;
  const rent = cat("Renda", 50000, "fixed");
  const food = cat("Supermercado", 30000, "variable");

  store.saveTransaction(db, { kind: "expense", date: "2026-10-03", amountCents: 5000, description: "", categoryId: food });
  store.saveTransaction(db, { kind: "expense", date: "2026-10-04", amountCents: 1000, description: "Café", categoryId: null });
  // Late and unpaid, from an account with no money in it.
  store.saveTransaction(db, { kind: "expense", date: "2026-10-05", amountCents: 2000, description: "", categoryId: food, paid: false, accountId: rev });
  const pot = store.savePot(db, { name: "Férias", goalCents: 0, sort: 0 });
  store.saveMovement(db, { potId: pot, date: "2026-10-06", amountCents: 3000, place: "", note: "", opening: false, accountId: main });
  store.savePersonalLoan(db, { person: "Ana", direction: "lent", date: "2026-09-01", amountCents: 4000, dueDate: null, note: "" });

  const o = overview(db, "2026-10", "2026-10-10");
  // 1000 € - 50 € - 10 € - 30 € saved = 910 € in the accounts.
  assert.deepEqual(o.available, {
    accountsCents: 91000,
    toPayCents: 2000,
    fixedLeftCents: 50000, // the rent isn't paid yet
    savingsLeftCents: 7000,
    freeCents: 91000 - 2000 - 50000 - 7000,
    daysLeft: 22,
    dayToDayLeftCents: 30000 - 5000 - 2000,
  });
  const byType = Object.fromEntries(o.todo.map((t) => [t.type, t]));
  assert.deepEqual([byType.uncategorised.count, byType.uncategorised.amountCents], [1, 1000]);
  assert.deepEqual([byType.pending.level, byType.pending.count, byType.pending.amountCents], ["bad", 1, 2000]);
  assert.deepEqual([byType.shortAccount.name, byType.shortAccount.amountCents], ["Revolut", 2000]);
  assert.equal(o.netWorth.totalCents, 91000 + 3000 + 4000);

  // Paying the rent leaves only the day-to-day money and what is still due.
  store.saveTransaction(db, { kind: "expense", date: "2026-10-08", amountCents: 50000, description: "", categoryId: rent });
  assert.equal(overview(db, "2026-10", "2026-10-10").available?.fixedLeftCents, 0);
  assert.equal(overview(db, "2026-10", "2026-10-10").available?.freeCents, 41000 - 2000 - 7000);
  // A past month has nothing free to spend, only things left to do.
  assert.equal(overview(db, "2026-09", "2026-10-10").available, null);
});
