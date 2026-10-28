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
  assert.deepEqual([byType.annualNext.name, byType.annualNext.amountCents], ["Seguro", 24000]);

  // A month in the future has nothing elapsed and no suggestions.
  const future = overview(db, "2026-12", "2026-10-10");
  assert.equal(future.elapsedDays, 0);
  assert.equal(future.projectedExpenseCents, null);
  assert.equal(future.tips.length, 0);
});
