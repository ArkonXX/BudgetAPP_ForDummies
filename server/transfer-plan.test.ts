import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import * as store from "./store.ts";
import { salaryAccount, transferPlan } from "./transfer-plan.ts";

function setup() {
  const db = openDb(":memory:");
  const revolut = store.listAccounts(db)[0].id; // the default account
  store.saveAccount(db, { id: revolut, name: "Revolut", openingCents: 0, isDefault: true, sort: 2, archived: false });
  const montepio = store.saveAccount(db, { name: "Montepio", openingCents: 0, isDefault: false, sort: 1, archived: false });
  const item = (section: "fixed" | "subscription" | "annual" | "investment", name: string, amountCents: number, accountId?: number, month: number | null = null) =>
    store.savePlanItem(db, { section, name, amountCents, month, sort: 0, accountId }, "2026-10-26");
  return { db, revolut, montepio, item };
}

test("the salary account is the setting, else where the last salary came in, else the default account", () => {
  const { db, revolut, montepio } = setup();
  assert.equal(salaryAccount(db), revolut);
  const salary = store.upsertCategory(db, { kind: "income", name: "Salário", plannedCents: 0, sort: 0, archived: false }).id;
  store.saveTransaction(db, { kind: "income", date: "2026-09-30", amountCents: 150000, description: "", categoryId: salary, accountId: montepio });
  assert.equal(salaryAccount(db), montepio);
  store.updateSettings(db, { salaryAccountId: revolut });
  assert.equal(salaryAccount(db), revolut);
});

test("each account gets its plan items and loan payments for the month and the installments due in it", () => {
  const { db, revolut, montepio, item } = setup();
  store.updateSettings(db, { salaryAccountId: montepio });
  item("fixed", "Quotas do clube", 1000, montepio); // paid from the salary account itself
  item("fixed", "Seguro casa", 3500); // no account = the default one (Revolut)
  item("subscription", "Spotify", 1099, revolut);
  item("investment", "PPR", 0, revolut); // nothing planned: left out
  item("annual", "Seguro automóvel", 30000, revolut, 11); // November only
  item("annual", "Domínio web", 1500, revolut, 8);
  store.saveLoan(db, { name: "Crédito carro", principalCents: 0, monthlyCents: 19875, paidOff: false, mortgage: false, sort: 0, amortizations: [], accountId: revolut });
  store.saveLoan(db, { name: "Crédito antigo", principalCents: 0, monthlyCents: 5000, paidOff: true, mortgage: false, sort: 1, amortizations: [], accountId: revolut });
  store.createInstallmentPlan(db, {
    name: "Klarna",
    totalCents: 6000,
    count: 3,
    everyDays: null,
    categoryId: null,
    accountId: revolut,
    firstDate: "2026-11-05",
    firstPaid: false,
  });

  const plan = transferPlan(db, "2026-11");
  assert.equal(plan.payday, "2026-10-30"); // last working day of October
  assert.equal(plan.salaryAccountId, montepio);
  assert.equal(plan.needs.length, 1);
  const [rev] = plan.needs;
  assert.equal(rev.accountId, revolut);
  assert.deepEqual(
    rev.parts.map((p) => [p.kind, p.name, p.cents]),
    [["annual", "Seguro automóvel", 30000], ["fixed", "Seguro casa", 3500], ["subscription", "Spotify", 1099], ["loan", "Crédito carro", 19875], ["unpaid", "Klarna", 2000]],
  );
  assert.equal(rev.neededCents, 30000 + 3500 + 1099 + 19875 + 2000);
  // December: no car insurance, the next installment.
  assert.equal(transferPlan(db, "2026-12").needs[0].neededCents, 3500 + 1099 + 19875 + 2000);
});

test("confirming records one transfer for the month and account", () => {
  const { db, revolut, montepio, item } = setup();
  store.updateSettings(db, { salaryAccountId: montepio });
  item("fixed", "Seguro casa", 3500, revolut);
  store.saveTransfer(db, { date: "2026-10-30", amountCents: 3500, fromAccountId: montepio, toAccountId: revolut, note: "", budgetMonth: "2026-11" });
  const [rev] = transferPlan(db, "2026-11").needs;
  assert.equal(rev.transfer?.amountCents, 3500);
  assert.equal(store.listAccounts(db).find((a) => a.id === revolut)!.balanceCents, 3500);
  assert.throws(() =>
    store.saveTransfer(db, { date: "2026-10-31", amountCents: 100, fromAccountId: montepio, toAccountId: revolut, note: "", budgetMonth: "2026-11" }),
  );
  // December is still open.
  assert.equal(transferPlan(db, "2026-12").needs[0].transfer, null);
});

test("day-to-day categories spent from another account add what is planned for them that month", () => {
  const { db, revolut, montepio } = setup();
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1, salaryAccountId: montepio });
  const cat = (name: string, plannedCents: number, accountId: number | null, group: "fixed" | "variable" = "variable") =>
    store.upsertCategory(db, { kind: "expense", name, plannedCents, sort: 0, archived: false, group, accountId }).id;
  const food = cat("Supermercado", 20000, revolut);
  cat("Combustível", 8000, revolut);
  cat("Lazer", 10000, null); // stays in the salary account
  cat("Jogos", 2000, montepio); // the salary account itself
  cat("Comunicação", 1000, revolut, "fixed"); // fixed expenses come from their Plan line
  store.setMonthPlan(db, "2026-11", food, 25000);

  const need = transferPlan(db, "2026-11").needs.find((n) => n.accountId === revolut)!;
  assert.deepEqual(
    need.parts.map((p) => [p.name, p.cents, p.kind]),
    [["Combustível", 8000, "category"], ["Supermercado", 25000, "category"]],
  );
  assert.equal(need.neededCents, 33000);
  // Saving the category without an account keeps the one it has; null clears it.
  const c = store.listCategories(db).find((x) => x.id === food)!;
  assert.equal(store.upsertCategory(db, { ...c, accountId: undefined }).accountId, revolut);
  assert.equal(store.upsertCategory(db, { ...c, accountId: null }).accountId, null);
});
