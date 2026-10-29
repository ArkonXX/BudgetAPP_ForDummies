import { test } from "node:test";
import assert from "node:assert/strict";
import { guessExpenseGroup, openDb } from "./db.ts";
import * as store from "./store.ts";
import { monthSummary, planGrid } from "./reports.ts";

test("plan grid: planned per month and what is left at the end of each month", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1, plannedSavingsCents: 10000 });
  const cat = (kind: "expense" | "income", name: string, plannedCents: number) =>
    store.upsertCategory(db, { kind, name, plannedCents, sort: 0, archived: false }).id;
  const salary = cat("income", "Salário", 100000);
  const food = cat("expense", "Supermercado", 30000);
  const fun = cat("expense", "Lazer", 5000);

  // September is over: only what really happened counts.
  store.saveTransaction(db, { kind: "income", date: "2026-09-01", amountCents: 100000, description: "", categoryId: salary });
  store.saveTransaction(db, { kind: "expense", date: "2026-09-10", amountCents: 120000, description: "", categoryId: food });
  // October (current): food over plan, and an unpaid fun expense.
  store.saveTransaction(db, { kind: "expense", date: "2026-10-05", amountCents: 40000, description: "", categoryId: food });
  store.saveTransaction(db, { kind: "expense", date: "2026-10-06", amountCents: 8000, description: "", categoryId: fun, paid: false });
  // December needs more for presents.
  store.setMonthPlan(db, "2026-12", fun, 95000);
  store.setMonthPlan(db, "2026-12", null, 0);

  const g = planGrid(db, "2026-09", 4, "2026-10-10");
  assert.deepEqual(
    g.months.map((m) => [m.month, m.status]),
    [["2026-09", "past"], ["2026-10", "current"], ["2026-11", "future"], ["2026-12", "future"]],
  );
  // Past: 1000 in, 1200 spent, nothing saved.
  assert.equal(g.months[0].endCents, -20000);
  // Current: 1000 planned in; food 400 (more than planned), fun 80 to pay, 100 saved.
  assert.equal(g.months[1].endCents, 100000 - 40000 - 8000 - 10000);
  // Later months: the plan; December uses its own amounts.
  assert.equal(g.months[2].endCents, 100000 - 30000 - 5000 - 10000);
  assert.equal(g.months[3].endCents, 100000 - 30000 - 95000);

  const funRow = g.rows.find((r) => r.categoryId === fun)!;
  assert.equal(funRow.cells[1].toPayCents, 8000);
  // The unpaid October expense isn't counted again in November.
  assert.equal(funRow.cells[2].toPayCents, 0);
  assert.deepEqual([funRow.cells[3].plannedCents, funRow.cells[3].custom], [95000, true]);

  // The month summary uses the month's own planned amounts too.
  const dec = monthSummary(db, "2026-12", "2026-10-10");
  assert.equal(dec.expenses.find((l) => l.categoryId === fun)!.plannedCents, 95000);
  assert.equal(dec.plannedSavingsCents, 0);

  // Back to the usual amount.
  store.setMonthPlan(db, "2026-12", fun, null);
  assert.equal(monthSummary(db, "2026-12", "2026-10-10").expenses.find((l) => l.categoryId === fun)!.plannedCents, 5000);
});

test("plan grid: money borrowed from people counts only in the month it is paid back", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1, plannedSavingsCents: 0 });
  store.upsertCategory(db, { kind: "income", name: "Salário", plannedCents: 100000, sort: 0, archived: false });
  store.savePersonalLoan(db, { person: "Rita", direction: "borrowed", date: "2026-10-10", amountCents: 1000, dueDate: null, note: "" });
  store.payPerson(db, { person: "Rita", direction: "borrowed", date: "2026-11-05", amountCents: 1000, note: "" }, "2026-11-05");

  const g = planGrid(db, "2026-10", 2, "2026-10-20");
  // October: borrowed, nothing to count. November: the €10 paid back.
  assert.equal(g.months[0].endCents, 100000);
  assert.equal(g.months[1].endCents, 100000 - 1000);
  const rita = g.rows.find((r) => r.kind === "repaid")!;
  assert.equal(rita.name, "Rita");
  assert.deepEqual(rita.cells.map((c) => c.actualCents), [0, 1000]);
});

test("money owed to people by a due date counts as planned in that month", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1, plannedSavingsCents: 0 });
  store.upsertCategory(db, { kind: "income", name: "Salário", plannedCents: 100000, sort: 0, archived: false });
  store.savePersonalLoan(db, { person: "Marta", direction: "borrowed", date: "2026-09-01", amountCents: 5000, dueDate: "2026-09-30", note: "" });
  store.savePersonalLoan(db, { person: "Rita", direction: "borrowed", date: "2026-10-01", amountCents: 3000, dueDate: "2026-11-15", note: "" });
  store.payPerson(db, { person: "Marta", direction: "borrowed", date: "2026-10-05", amountCents: 2000, note: "" });

  // October (current): €20 paid to Marta, the other €30 overdue still to pay. Rita is due in November.
  const oct = monthSummary(db, "2026-10", "2026-10-20");
  assert.equal(oct.repaidCents, 2000);
  assert.deepEqual(oct.repaidDue, [{ person: "Marta", cents: 3000 }]);
  assert.equal(oct.repaidDueCents, 3000);
  const nov = monthSummary(db, "2026-11", "2026-10-20");
  assert.deepEqual(nov.repaidDue, [{ person: "Rita", cents: 3000 }]);
  // A past month only counts what was paid.
  assert.deepEqual(monthSummary(db, "2026-09", "2026-10-20").repaidDue, []);

  const g = planGrid(db, "2026-10", 2, "2026-10-20");
  assert.equal(g.months[0].endCents, 100000 - 2000 - 3000);
  assert.equal(g.months[1].endCents, 100000 - 3000);
  const rita = g.rows.find((r) => r.kind === "repaid" && r.name === "Rita")!;
  assert.deepEqual(rita.cells.map((c) => c.toPayCents), [0, 3000]);
});

test("a repayment to a person dated ahead counts as planned in its month", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1, plannedSavingsCents: 0 });
  store.upsertCategory(db, { kind: "income", name: "Salário", plannedCents: 100000, sort: 0, archived: false });
  store.savePersonalLoan(db, { person: "Marta", direction: "borrowed", date: "2026-09-01", amountCents: 10000, dueDate: null, note: "" }, "2026-10-20");
  store.payPerson(db, { person: "Marta", direction: "borrowed", date: "2026-11-10", amountCents: 4000, note: "" }, "2026-10-20");

  assert.deepEqual(monthSummary(db, "2026-10", "2026-10-20").repaidDue, []);
  const nov = monthSummary(db, "2026-11", "2026-10-20");
  assert.equal(nov.repaidCents, 0);
  assert.deepEqual(nov.repaidDue, [{ person: "Marta", cents: 4000 }]);
  const g = planGrid(db, "2026-10", 2, "2026-10-20");
  assert.equal(g.months[1].endCents, 100000 - 4000);
});

test("expense groups: guessed from the name, editable, and on the budget and the plan", () => {
  const db = openDb(":memory:");
  const cat = (name: string, group?: "credit" | "fixed" | "variable") =>
    store.upsertCategory(db, { kind: "expense", name, plannedCents: 1000, sort: 0, archived: false, group });
  assert.equal(guessExpenseGroup("Créditos"), "credit");
  assert.equal(guessExpenseGroup("Armortizações"), "credit");
  assert.equal(guessExpenseGroup("Comunicação"), "fixed");
  assert.equal(guessExpenseGroup("Despesas Bancarias"), "fixed");
  assert.equal(guessExpenseGroup("Finaciamentos"), "credit");
  assert.equal(guessExpenseGroup("Supermercado"), "variable");
  assert.equal(cat("Créditos").group, "credit");
  const games = cat("Jogos");
  assert.equal(games.group, "variable");
  // Saving without a group keeps the one it has.
  const gym = cat("Ginásio", "fixed");
  assert.equal(store.upsertCategory(db, { ...gym, plannedCents: 2000, group: undefined }).group, "fixed");

  const s = monthSummary(db, "2026-10");
  assert.deepEqual(
    s.expenses.map((l) => [l.name, l.group]),
    [["Créditos", "credit"], ["Ginásio", "fixed"], ["Jogos", "variable"]],
  );
  assert.equal(planGrid(db, "2026-10", 1, "2026-10-10").rows.find((r) => r.categoryId === games.id)!.group, "variable");
});

test("expense lines name the accounts the money leaves from", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1 });
  const main = store.listAccounts(db)[0].id;
  const card = store.saveAccount(db, { name: "Revolut", openingCents: 0, isDefault: false, sort: 1, archived: false });
  const cat = (name: string) => store.upsertCategory(db, { kind: "expense", name, plannedCents: 0, sort: 0, archived: false }).id;
  const food = cat("Supermercado");
  const fun = cat("Lazer");
  cat("Roupa");
  store.saveTransaction(db, { kind: "expense", date: "2026-10-05", amountCents: 1000, description: "", categoryId: food });
  store.saveTransaction(db, { kind: "expense", date: "2026-10-06", amountCents: 1000, description: "", categoryId: food, accountId: card });
  store.saveTransaction(db, { kind: "expense", date: "2026-10-07", amountCents: 1000, description: "", categoryId: fun, accountId: card, paid: false });
  const s = monthSummary(db, "2026-10", "2026-10-10");
  const of = (name: string) => s.expenses.find((l) => l.name === name)!.accountIds.sort();
  assert.deepEqual(of("Supermercado"), [main, card].sort());
  assert.deepEqual(of("Lazer"), [card]);
  assert.deepEqual(of("Roupa"), []);
});

test("Plan lines and bank loans count in the budget and the year plan", () => {
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1, plannedSavingsCents: 0 });
  const cat = (name: string, plannedCents: number) => store.upsertCategory(db, { kind: "expense", name, plannedCents, sort: 0, archived: false }).id;
  store.upsertCategory(db, { kind: "income", name: "Salário", plannedCents: 100000, sort: 0, archived: false });
  const subs = cat("Subscrições", 999);
  const credit = cat("Créditos", 0);
  const item = (section: "fixed" | "subscription" | "annual", name: string, amountCents: number, extra = {}) =>
    store.savePlanItem(db, { section, name, amountCents, month: null, sort: 0, ...extra });
  item("subscription", "Netflix", 1500);
  item("subscription", "Spotify", 1000);
  item("fixed", "Renda", 50000);
  item("annual", "Seguro", 30000, { month: 12 });
  store.saveLoan(db, { name: "Carro", principalCents: 0, monthlyCents: 20000, paidOff: false, mortgage: false, sort: 0, amortizations: [], categoryId: credit });
  store.saveLoan(db, { name: "Pessoal", principalCents: 0, monthlyCents: 5000, paidOff: false, mortgage: false, sort: 1, amortizations: [] });

  const nov = monthSummary(db, "2026-11", "2026-10-10");
  // Subscriptions without a category count in Subscrições, instead of its usual amount.
  const subsLine = nov.expenses.find((l) => l.categoryId === subs)!;
  assert.equal(subsLine.plannedCents, 2500);
  assert.deepEqual(subsLine.fromPlan, ["Netflix", "Spotify"]);
  assert.equal(nov.expenses.find((l) => l.categoryId === credit)!.plannedCents, 20000);
  // Lines without a category are their own lines; the annual one only in its month.
  const own = nov.expenses.filter((l) => l.planKey).map((l) => [l.name, l.group, l.plannedCents]);
  assert.deepEqual(own, [["Renda", "fixed", 50000], ["Pessoal", "credit", 5000]]);
  assert.equal(nov.plannedExpenseCents, 2500 + 20000 + 50000 + 5000);
  assert.ok(monthSummary(db, "2026-12", "2026-10-10").expenses.some((l) => l.name === "Seguro" && l.plannedCents === 30000));

  // A month's own amount still wins.
  store.setMonthPlan(db, "2026-11", subs, 4000);
  assert.equal(monthSummary(db, "2026-11", "2026-10-10").expenses.find((l) => l.categoryId === subs)!.plannedCents, 4000);

  // The year plan shows and counts the same.
  const g = planGrid(db, "2026-11", 2, "2026-10-10");
  const seguro = g.rows.find((r) => r.name === "Seguro")!;
  assert.equal(seguro.planLine, true);
  assert.deepEqual(seguro.cells.map((c) => c.plannedCents), [0, 30000]);
  assert.deepEqual(g.rows.find((r) => r.categoryId === subs)!.fromPlan, ["Netflix", "Spotify"]);
  assert.equal(g.months[0].endCents, 100000 - 4000 - 20000 - 50000 - 5000);
  assert.equal(g.months[1].endCents, 100000 - 2500 - 20000 - 50000 - 5000 - 30000);
});

test("Plan lines and loans are tied to a category with the same name, or the usual one", async () => {
  const { tiePlanLines } = await import("./db.ts");
  const db = openDb(":memory:");
  const cat = (name: string) => store.upsertCategory(db, { kind: "expense", name, plannedCents: 0, sort: 0, archived: false }).id;
  const rent = cat("Renda");
  const inv = cat("Investimentos");
  const credit = cat("Créditos");
  const a = store.savePlanItem(db, { section: "fixed", name: "renda", amountCents: 1, month: null, sort: 0 });
  const b = store.savePlanItem(db, { section: "investment", name: "ETF", amountCents: 1, month: null, sort: 0 });
  const c = store.savePlanItem(db, { section: "fixed", name: "Ginásio", amountCents: 1, month: null, sort: 0 });
  store.saveLoan(db, { name: "Carro", principalCents: 0, monthlyCents: 1, paidOff: false, mortgage: false, sort: 0, amortizations: [] });
  tiePlanLines(db);
  const items = store.listPlanItems(db);
  assert.equal(items.find((i) => i.id === a)!.categoryId, rent);
  assert.equal(items.find((i) => i.id === b)!.categoryId, inv);
  assert.equal(items.find((i) => i.id === c)!.categoryId, null);
  assert.equal(store.listLoans(db)[0].categoryId, credit);
});
