import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";

test("login, add an expense and read the month summary", async () => {
  const db = openDb(":memory:");
  const server = createApp(db, { password: "correct-horse", secureCookie: false }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const headers = { "Content-Type": "application/json", "X-Budget-App": "1" };
  try {
    assert.equal((await fetch(`${base}/summary?month=2026-02`)).status, 401);

    const bad = await fetch(`${base}/login`, { method: "POST", headers, body: '{"password":"nope"}' });
    assert.equal(bad.status, 401);

    const ok = await fetch(`${base}/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "correct-horse" }),
    });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0];
    const authed = { ...headers, Cookie: cookie };

    const cat = (await (
      await fetch(`${base}/categories`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({ kind: "expense", name: "Supermercado", plannedCents: 12000 }),
      })
    ).json()) as { id: number };

    // Writes without the custom header are refused (CSRF protection).
    const noHeader = await fetch(`${base}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{}",
    });
    assert.equal(noHeader.status, 403);

    const t = await fetch(`${base}/transactions`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ kind: "expense", date: "2026-02-03", amountCents: 4550, categoryId: cat.id }),
    });
    assert.equal(t.status, 200);

    const summary = (await (await fetch(`${base}/summary?month=2026-02`, { headers: authed })).json()) as {
      expenses: { name: string; actualCents: number; plannedCents: number }[];
    };
    const line = summary.expenses.find((e) => e.name === "Supermercado")!;
    assert.equal(line.actualCents, 4550);
    assert.equal(line.plannedCents, 12000);

    const invalid = await fetch(`${base}/transactions`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({ kind: "expense", date: "yesterday", amountCents: 1 }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    server.close();
  }
});

test("personal loans track what is still owed", async () => {
  const db = openDb(":memory:");
  const server = createApp(db, { password: "correct-horse", secureCookie: false }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const headers = { "Content-Type": "application/json", "X-Budget-App": "1" };
  try {
    const ok = await fetch(`${base}/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "correct-horse" }),
    });
    const authed = { ...headers, Cookie: ok.headers.get("set-cookie")!.split(";")[0] };
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: authed, body: JSON.stringify(body) });

    const loan = (await (
      await post("/loans/personal", { person: "João", direction: "lent", date: "2026-10-01", amountCents: 20000 })
    ).json()) as { id: number };
    assert.equal((await post("/loans/payments", { loanId: loan.id, date: "2026-10-20", amountCents: 5000 })).status, 200);
    assert.equal((await post("/loans/personal", { person: "Ana", direction: "sideways", date: "2026-10-01", amountCents: 1 })).status, 400);

    const data = (await (await fetch(`${base}/loans`, { headers: authed })).json()) as {
      personal: { person: string; paidCents: number; outstandingCents: number; dueDate: string | null }[];
    };
    assert.equal(data.personal.length, 1);
    assert.equal(data.personal[0].paidCents, 5000);
    assert.equal(data.personal[0].outstandingCents, 15000);
    assert.equal(data.personal[0].dueDate, null);

    await fetch(`${base}/loans/personal/${loan.id}`, { method: "DELETE", headers: authed });
    const after = (await (await fetch(`${base}/loans`, { headers: authed })).json()) as { personal: unknown[] };
    assert.equal(after.personal.length, 0);
  } finally {
    server.close();
  }
});

test("loans can be marked paid off, also on databases from before the flag", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = await import("./store.ts");
  const file = join(mkdtempSync(join(tmpdir(), "budget-")), "old.db");
  const old = new DatabaseSync(file);
  old.exec(
    "CREATE TABLE loans (id INTEGER PRIMARY KEY, name TEXT NOT NULL, principal_cents INTEGER NOT NULL DEFAULT 0, monthly_cents INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0); INSERT INTO loans (name, monthly_cents) VALUES ('Carro', 25000);",
  );
  old.close();

  const db = openDb(file);
  const [loan] = store.listLoans(db);
  assert.equal(loan.paidOff, false);
  assert.equal(loan.mortgage, false);
  store.saveLoan(db, { ...loan, paidOff: true });
  assert.equal(store.listLoans(db)[0].paidOff, true);
  db.close();
});

test("baby steps are worked out from pots, loans, expenses and the plan", async () => {
  const store = await import("./store.ts");
  const { computeBabySteps } = await import("./baby-steps.ts");
  const db = openDb(":memory:");
  const status = () => computeBabySteps(db, "2026-10-26").map((s) => s.status);

  // Nothing yet: no emergency fund, no expenses, no salary; 5 and 6 do not apply.
  assert.deepEqual(status(), ["pending", "done", "pending", "pending", "na", "na", "pending"]);

  const pot = store.ensurePot(db, "Emergências");
  store.saveMovement(db, { potId: pot, date: "2026-01-01", amountCents: 120000, place: "", note: "", opening: true });
  const car = store.saveLoan(db, { name: "Carro", principalCents: 0, monthlyCents: 25000, paidOff: false, mortgage: false, sort: 1, amortizations: [] });
  store.saveLoan(db, { name: "Casa", principalCents: 0, monthlyCents: 60000, paidOff: false, mortgage: true, sort: 2, amortizations: [] });
  assert.deepEqual(status().slice(0, 2), ["done", "pending"]);

  store.saveLoan(db, { ...store.listLoans(db).find((l) => l.id === car)!, paidOff: true });
  assert.equal(status()[1], "done");
  assert.equal(status()[5], "pending");

  // Step 3: 2 months of 500 € expenses each (current month ignored) -> 6 months = 3000 €.
  store.saveTransaction(db, { kind: "expense", date: "2026-08-10", amountCents: 50000, description: "", categoryId: null });
  store.saveTransaction(db, { kind: "expense", date: "2026-09-10", amountCents: 50000, description: "", categoryId: null });
  store.saveTransaction(db, { kind: "expense", date: "2026-10-10", amountCents: 999999, description: "", categoryId: null });
  assert.deepEqual(computeBabySteps(db, "2026-10-26")[2].progress, { current: 120000, target: 300000, unit: "cents" });
  store.saveMovement(db, { potId: pot, date: "2026-10-01", amountCents: 180000, place: "", note: "", opening: false });
  assert.equal(status()[2], "done");

  // Step 4: 15% of 2000 € salary = 300 € of planned investments.
  store.updateSettings(db, { salaryCents: 200000 });
  store.savePlanItem(db, { section: "investment", name: "ETF", amountCents: 30000, month: null, sort: 1 });
  assert.equal(status()[3], "done");

  // Step 5 applies once an education pot is chosen.
  const edu = store.savePot(db, { name: "Educação", goalCents: 100000, sort: 2 });
  store.updateBabyStepSettings(db, { educationPotId: edu });
  assert.equal(status()[4], "pending");
  store.updateBabyStepSettings(db, { educationPotId: null });

  const house = store.listLoans(db).find((l) => l.mortgage)!;
  store.saveLoan(db, { ...house, paidOff: true });
  assert.deepEqual(status(), ["done", "done", "done", "done", "na", "done", "done"]);
  db.close();
});

test("unpaid expenses stay out of the totals and carry over until paid", async () => {
  const store = await import("./store.ts");
  const { monthSummary } = await import("./reports.ts");
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartDay: 1 });
  const cat = store.ensureCategory(db, "expense", "Saúde");
  const bill = store.saveTransaction(db, {
    kind: "expense",
    date: "2026-10-15",
    amountCents: 6000,
    description: "Consulta",
    categoryId: cat,
    paid: false,
  });
  assert.equal(bill.paid, false);
  // Income is always paid.
  assert.equal(
    store.saveTransaction(db, { kind: "income", date: "2026-10-01", amountCents: 1, description: "", categoryId: null, paid: false }).paid,
    true,
  );

  const oct = monthSummary(db, "2026-10");
  assert.equal(oct.totalExpenseCents, 0);
  assert.equal(oct.pendingCents, 6000);
  assert.equal(oct.pending[0].dueMonth, "2026-10");

  const nov = monthSummary(db, "2026-11");
  assert.deepEqual(nov.pending.map((p) => p.description), ["Consulta"]);
  assert.equal(monthSummary(db, "2026-09").pending.length, 0);

  store.payTransaction(db, bill.id, "2026-11-03");
  const after = monthSummary(db, "2026-11");
  assert.equal(after.pending.length, 0);
  assert.equal(after.totalExpenseCents, 6000);
  assert.equal(monthSummary(db, "2026-10").totalExpenseCents, 0);
});

test("entries dated ahead only count once their day comes and they are confirmed", async () => {
  const store = await import("./store.ts");
  const { monthSummary } = await import("./reports.ts");
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1 });
  const cat = store.ensureCategory(db, "expense", "Casa");
  const balance = () => store.listAccounts(db)[0].balanceCents;
  const add = (kind: "expense" | "income", description: string, today: string) =>
    store.saveTransaction(db, { kind, date: "2026-11-10", amountCents: 3000, description, categoryId: kind === "expense" ? cat : null }, today);

  // Entered on the 9th for the 10th: waiting, out of the totals and the balance.
  const rent = add("expense", "Renda", "2026-11-09");
  const gas = add("expense", "Gás", "2026-11-09");
  const refund = add("income", "Reembolso", "2026-11-09");
  assert.deepEqual([rent.scheduled, rent.paid, refund.scheduled, refund.paid], [true, false, true, false]);
  assert.equal(balance(), 0);
  const before = monthSummary(db, "2026-11", "2026-11-09");
  assert.equal(before.totalExpenseCents, 0);
  assert.equal(before.totalIncomeCents, 0);
  // Expenses still show as to pay in the month; income doesn't.
  assert.equal(before.pendingCents, 6000);
  assert.equal(store.listToConfirm(db, "2026-11-09").length, 0);

  // On the 10th the app asks about them. Editing one keeps it waiting.
  assert.deepEqual(store.listToConfirm(db, "2026-11-10").map((t) => t.label), ["Renda", "Gás", "Reembolso"]);
  store.saveTransaction(db, { ...rent, description: "Renda casa" }, "2026-11-11");
  assert.equal(store.listToConfirm(db, "2026-11-11").length, 3);

  // Debited: it counts on its own date.
  const paid = store.confirmTransaction(db, rent.id, true, "2026-11-11")!;
  assert.deepEqual([paid.paid, paid.scheduled, paid.date], [true, false, "2026-11-10"]);
  assert.equal(balance(), -3000);
  // Not yet: an expense stays to pay, income is expected the next day.
  const owed = store.confirmTransaction(db, gas.id, false, "2026-11-11")!;
  assert.deepEqual([owed.paid, owed.scheduled], [false, false]);
  const later = store.confirmTransaction(db, refund.id, false, "2026-11-11")!;
  assert.deepEqual([later.paid, later.scheduled, later.date], [false, true, "2026-11-12"]);
  assert.deepEqual(store.listToConfirm(db, "2026-11-11").map((t) => t.label), []);

  const after = monthSummary(db, "2026-11", "2026-11-11");
  assert.equal(after.totalExpenseCents, 3000);
  assert.deepEqual(after.pending.map((t) => t.description), ["Gás"]);

  // Moving one to a day that has passed means it happened then.
  const moved = store.saveTransaction(db, { ...later, date: "2026-11-11" }, "2026-11-11");
  assert.deepEqual([moved.paid, moved.scheduled], [true, false]);
  assert.equal(balance(), 0);
});

test("transfers, savings and money to or from people dated ahead also wait for their day", async () => {
  const store = await import("./store.ts");
  const { monthSummary } = await import("./reports.ts");
  const db = openDb(":memory:");
  store.updateSettings(db, { monthStartMode: "fixedDay", monthStartDay: 1 });
  const main = store.listAccounts(db)[0].id;
  const other = store.saveAccount(db, { name: "Poupança", openingCents: 0, isDefault: false, sort: 1, archived: false } as never);
  const pot = store.ensurePot(db, "Férias");
  const balances = () => store.listAccounts(db).map((a) => a.balanceCents);
  const day = "2026-11-09";
  const date = "2026-11-10";

  store.saveTransfer(db, { date, amountCents: 1000, fromAccountId: main, toAccountId: other, note: "" }, day);
  store.saveMovement(db, { potId: pot, date, amountCents: 2000, place: "", note: "", opening: false, accountId: main }, day);
  store.savePersonalLoan(db, { person: "Ana", direction: "lent", date: "2026-11-01", amountCents: 5000, dueDate: null, note: "", accountId: main }, "2026-11-01");
  store.savePersonalLoan(db, { person: "Rui", direction: "borrowed", date, amountCents: 3000, dueDate: null, note: "", accountId: main }, day);
  store.payPerson(db, { person: "Ana", direction: "lent", date, amountCents: 4000, note: "", accountId: main }, day);

  // Only Ana's loan, dated on the 1st, has moved money.
  assert.deepEqual(balances(), [-5000, 0]);
  assert.equal(store.listPots(db)[0].balanceCents, 0);
  assert.equal(monthSummary(db, "2026-11", day).savingsCents, 0);
  // What Ana still owes already counts the repayment she said she'd make.
  assert.equal(store.listPersonalLoans(db).find((l) => l.person === "Ana")!.outstandingCents, 1000);
  assert.equal(store.listToConfirm(db, day).length, 0);

  const due = store.listToConfirm(db, date);
  assert.deepEqual(due.map((x) => [x.type, x.amountCents]), [["transfer", 1000], ["savings", -2000], ["loan", 3000], ["repayment", 4000]]);
  for (const x of due.filter((x) => x.type !== "loan")) store.confirmScheduled(db, x.type as "transfer", x.key, true, date);
  // Rui's money hasn't arrived: asked again tomorrow.
  store.confirmScheduled(db, "loan", due.find((x) => x.type === "loan")!.key, false, date);

  assert.deepEqual(balances(), [-5000 - 1000 - 2000 + 4000, 1000]);
  assert.equal(store.listPots(db)[0].balanceCents, 2000);
  assert.equal(monthSummary(db, "2026-11", date).savingsCents, 2000);
  assert.deepEqual(store.listToConfirm(db, date).length, 0);
  assert.deepEqual(store.listToConfirm(db, "2026-11-11").map((x) => [x.type, x.date]), [["loan", "2026-11-11"]]);
});

test("accounts keep their own balance and transfers stay out of the budget", async () => {
  const db = openDb(":memory:");
  const server = createApp(db, { password: "correct-horse", secureCookie: false }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const headers = { "Content-Type": "application/json", "X-Budget-App": "1" };
  try {
    const ok = await fetch(`${base}/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ password: "correct-horse" }),
    });
    const authed = { ...headers, Cookie: ok.headers.get("set-cookie")!.split(";")[0] };
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: authed, body: JSON.stringify(body) });
    const get = async <T>(path: string) => (await (await fetch(`${base}${path}`, { headers: authed })).json()) as T;
    type Acc = { id: number; name: string; isDefault: boolean; balanceCents: number };

    // A fresh database starts with one default account.
    const [main] = await get<Acc[]>("/accounts");
    assert.equal(main.isDefault, true);
    await post("/accounts", { id: main.id, name: "Montepio", openingCents: 100000, isDefault: true });
    const rev = (await (await post("/accounts", { name: "Revolut" })).json()) as { id: number };
    assert.equal((await post("/accounts", { name: "revolut" })).status, 400);

    // No account given: the entry goes to the default account.
    await post("/transactions", { kind: "income", date: "2026-02-03", amountCents: 50000 });
    await post("/transactions", { kind: "expense", date: "2026-02-04", amountCents: 2000, accountId: rev.id });
    // Not paid yet: the money is still in the account.
    await post("/transactions", { kind: "expense", date: "2026-02-04", amountCents: 900, accountId: rev.id, paid: false });
    assert.equal((await post("/transactions", { kind: "expense", date: "2026-02-04", amountCents: 1, accountId: 999 })).status, 400);
    assert.equal((await post("/transfers", { date: "2026-02-05", amountCents: 30000, fromAccountId: main.id, toAccountId: rev.id })).status, 200);
    assert.equal((await post("/transfers", { date: "2026-02-05", amountCents: 1, fromAccountId: rev.id, toAccountId: rev.id })).status, 400);

    // Savings deposits leave the account they came from; ones without an account don't count.
    const pot = (await (await post("/savings/pots", { name: "Férias" })).json()) as { id: number };
    await post("/savings/movements", { potId: pot.id, date: "2026-02-06", amountCents: 10000, accountId: main.id });
    await post("/savings/movements", { potId: pot.id, date: "2026-02-06", amountCents: 7000 });
    await post("/savings/movements", { potId: pot.id, date: "2026-02-07", amountCents: -2500, accountId: main.id });

    const accounts = await get<Acc[]>("/accounts");
    assert.equal(accounts.find((a) => a.id === main.id)!.balanceCents, 100000 + 50000 - 30000 - 10000 + 2500);
    assert.equal(accounts.find((a) => a.id === rev.id)!.balanceCents, 30000 - 2000);
    assert.equal((await get<unknown[]>(`/transactions?account=${rev.id}`)).length, 2);

    const summary = await get<{ totalIncomeCents: number; totalExpenseCents: number }>("/summary?month=2026-02");
    assert.equal(summary.totalIncomeCents, 50000);
    assert.equal(summary.totalExpenseCents, 2000);

    // Accounts with transfers, and the default account, can't be deleted.
    assert.equal((await fetch(`${base}/accounts/${rev.id}`, { method: "DELETE", headers: authed })).status, 400);
    assert.equal((await fetch(`${base}/accounts/${main.id}`, { method: "DELETE", headers: authed })).status, 400);
  } finally {
    server.close();
  }
});

test("wipe deletes all data only with the right password and keeps settings and the login", async () => {
  const db = openDb(":memory:");
  const server = createApp(db, { password: "correct-horse", secureCookie: false }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const headers = { "Content-Type": "application/json", "X-Budget-App": "1" };
  try {
    const ok = await fetch(`${base}/login`, { method: "POST", headers, body: JSON.stringify({ password: "correct-horse" }) });
    const authed = { ...headers, Cookie: ok.headers.get("set-cookie")!.split(";")[0] };
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: authed, body: JSON.stringify(body) });

    await post("/categories", { kind: "expense", name: "Casa", plannedCents: 100 });
    await post("/transactions", { kind: "expense", date: "2026-02-03", amountCents: 4550 });
    await fetch(`${base}/settings`, { method: "PUT", headers: authed, body: JSON.stringify({ monthStartMode: "fixedDay", monthStartDay: 10 }) });

    assert.equal((await post("/wipe", { password: "nope" })).status, 401);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n, 1);

    assert.equal((await post("/wipe", { password: "correct-horse" })).status, 200);
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert.equal(count("transactions"), 0);
    assert.equal(count("categories"), 0);
    const accounts = db.prepare("SELECT name, is_default FROM accounts").all() as { name: string; is_default: number }[];
    assert.deepEqual(accounts.map((a) => [a.name, a.is_default]), [["Conta principal", 1]]);

    // Still logged in, and the settings are kept.
    const settings = (await (await fetch(`${base}/settings`, { headers: authed })).json()) as { monthStartDay: number };
    assert.equal(settings.monthStartDay, 10);
  } finally {
    server.close();
  }
});

test("a repayment to a person pays their oldest loans first", async () => {
  const store = await import("./store.ts");
  const db = openDb(":memory:");
  const borrow = (date: string, amountCents: number, person = "Rita") =>
    store.savePersonalLoan(db, { person, direction: "borrowed", date, amountCents, dueDate: null, note: "" });
  const first = borrow("2026-10-22", 2000);
  const second = borrow("2026-10-24", 210, " rita ");
  const third = borrow("2026-10-25", 1715);
  borrow("2026-10-01", 500, "Ana");

  assert.equal(store.payPerson(db, { person: "RITA", direction: "borrowed", date: "2026-10-26", amountCents: 9999, note: "" }), null);
  const res = store.payPerson(db, { person: "Rita", direction: "borrowed", date: "2026-10-26", amountCents: 2500, note: "MBWay" });
  assert.equal(res?.paid, 3);

  const byId = new Map(store.listPersonalLoans(db).map((l) => [l.id, l]));
  assert.equal(byId.get(first)!.outstandingCents, 0);
  assert.equal(byId.get(second)!.outstandingCents, 0);
  assert.equal(byId.get(third)!.outstandingCents, 1715 - 290);
  assert.equal(byId.get(third)!.payments[0].batch, res!.batch);

  const { debts } = await import("./overview.ts");
  const d = debts(db);
  assert.equal(d.iOweCents, 1715 - 290 + 500);
  assert.deepEqual(d.people.map((p) => [p.person, p.netCents]), [["Rita", -(1715 - 290)], ["Ana", -500]]);

  store.deletePaymentBatch(db, res!.batch);
  assert.ok(store.listPersonalLoans(db).every((l) => l.paidCents === 0));
});

test("loan moves list loans and repayments by month, with a split repayment as one move", async () => {
  const store = await import("./store.ts");
  const db = openDb(":memory:");
  const account = store.listAccounts(db)[0].id;
  store.savePersonalLoan(db, { person: "Rita", direction: "borrowed", date: "2026-10-22", amountCents: 2000, dueDate: null, note: "", accountId: account });
  store.savePersonalLoan(db, { person: "Rita", direction: "borrowed", date: "2026-10-24", amountCents: 210, dueDate: null, note: "" });
  store.payPerson(db, { person: "Rita", direction: "borrowed", date: "2026-10-27", amountCents: 2100, note: "MBWay", accountId: account });

  const moves = store.listLoanMoves(db, "2026-10-01", "2026-11-01");
  assert.deepEqual(
    moves.map((m) => [m.date, m.repay, m.amountCents]),
    [["2026-10-27", true, -2100], ["2026-10-24", false, 210], ["2026-10-22", false, 2000]],
  );
  assert.equal(store.listLoanMoves(db, "2026-10-25", "2026-11-01").length, 1);
  // The repayment left the account: 20.00 in, 21.00 out.
  assert.equal(store.listAccounts(db)[0].balanceCents, 2000 - 2100);
});
