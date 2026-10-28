import express, { type Request, type Response } from "express";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DB } from "./db.ts";
import { createAuth, passwordMatches } from "./auth.ts";
import * as store from "./store.ts";
import { balanceReport, monthSummary, planGrid } from "./reports.ts";
import { overview } from "./overview.ts";
import { importWorkbook } from "./import-excel.ts";
import { commitStatement, previewStatement, StatementError } from "./bank-import.ts";
import { computeBabySteps } from "./baby-steps.ts";
import { chargeSubscriptions, upcomingDebits } from "./subscriptions.ts";
import { transferPlan } from "./transfer-plan.ts";
import { closeMonth, CloseError, reopenMonth } from "./month-close.ts";
import { monthStartOf, periodRange, todayISO } from "../shared/period.ts";
import type { CloseAction, ExpenseGroup, Kind, PersonalLoanDirection, PlanSection } from "../shared/types.ts";

class BadRequest extends Error {}
// Something dated in a closed month would change: it has to be reopened first.
class MonthClosed extends Error {}

// Small validators: the API only accepts the exact shapes it expects.
const str = (v: unknown, field: string, max = 200): string => {
  if (typeof v !== "string" || v.length > max) throw new BadRequest(`invalid ${field}`);
  return v.trim();
};
const int = (v: unknown, field: string, min = -1e12, max = 1e12): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new BadRequest(`invalid ${field}`);
  return v;
};
const dateStr = (v: unknown, field = "date"): string => {
  const s = str(v, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new BadRequest(`invalid ${field}`);
  return s;
};
const monthStr = (v: unknown): string => {
  const s = str(v, "month", 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw new BadRequest("invalid month");
  return s;
};
const kind = (v: unknown): Kind => {
  if (v !== "expense" && v !== "income") throw new BadRequest("invalid kind");
  return v;
};
const section = (v: unknown): PlanSection => {
  if (!["fixed", "subscription", "investment", "donation", "annual"].includes(v as string))
    throw new BadRequest("invalid section");
  return v as PlanSection;
};
const direction = (v: unknown): PersonalLoanDirection => {
  if (v !== "lent" && v !== "borrowed") throw new BadRequest("invalid direction");
  return v;
};
const startMode = (v: unknown): "lastBusinessDay" | "fixedDay" => {
  if (v !== "lastBusinessDay" && v !== "fixedDay") throw new BadRequest("invalid monthStartMode");
  return v;
};
const closeAction = (v: unknown): CloseAction => {
  if (v !== "carry" && v !== "pot" && v !== "none") throw new BadRequest("invalid action");
  return v;
};
const expenseGroup = (v: unknown): ExpenseGroup => {
  if (v === "credit" || v === "fixed" || v === "variable") return v;
  throw new BadRequest("group must be credit, fixed or variable");
};
const optId = (v: unknown) => (v == null ? undefined : int(v, "id", 1));
const idParam = (req: Request) => int(Number(req.params.id), "id", 1);

export function createApp(db: DB, opts: { password: string; secureCookie: boolean; staticDir?: string }) {
  const app = express();
  const auth = createAuth(db, opts);

  // Refuses a change to anything dated in a closed month (falsy dates are skipped).
  const ensureOpen = (...dates: (string | null | undefined | false | 0)[]) => {
    if (dates.some((d) => d && store.isClosedDate(db, d))) throw new MonthClosed();
  };
  const dateOf = (table: string, id: number | undefined, extra = "") =>
    id == null
      ? undefined
      : ((db.prepare(`SELECT date ${extra} FROM ${table} WHERE id = ?`).get(id) as { date: string; paid?: number } | undefined));
  const datesOf = (sql: string, ...params: (string | number)[]) =>
    (db.prepare(sql).all(...params) as { date: string }[]).map((r) => r.date);

  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    );
    next();
  });

  const api = express.Router();
  api.use(express.json({ limit: "1mb" }));

  api.post("/login", (req, res) => {
    if (req.get("X-Budget-App") !== "1") {
      res.status(403).json({ error: "missing_header" });
      return;
    }
    auth.login(req, res);
  });
  api.post("/logout", auth.logout);
  api.get("/me", (req, res) => {
    res.json({ loggedIn: auth.isLoggedIn(req) });
  });

  api.use(auth.requireAuth);

  // Subscriptions whose debit day has come are added as expenses before anything is read.
  api.use((_req, _res, next) => {
    chargeSubscriptions(db, todayISO());
    next();
  });

  // Settings
  api.get("/settings", (_req, res) => {
    res.json(store.getSettings(db));
  });
  api.put("/settings", (req, res) => {
    const b = req.body ?? {};
    res.json(
      store.updateSettings(db, {
        salaryCents: b.salaryCents === undefined ? undefined : int(b.salaryCents, "salaryCents", 0),
        monthStartMode: b.monthStartMode === undefined ? undefined : startMode(b.monthStartMode),
        monthStartDay:
          b.monthStartDay === undefined ? undefined : int(b.monthStartDay, "monthStartDay", 1, 28),
        plannedSavingsCents:
          b.plannedSavingsCents === undefined
            ? undefined
            : int(b.plannedSavingsCents, "plannedSavingsCents", 0),
        salaryAccountId:
          b.salaryAccountId === undefined ? undefined : b.salaryAccountId == null ? null : accountId(b.salaryAccountId, "salaryAccountId"),
      }),
    );
  });

  // Categories
  api.get("/categories", (_req, res) => {
    res.json(store.listCategories(db));
  });
  api.post("/categories", (req, res) => {
    const b = req.body ?? {};
    res.json(
      store.upsertCategory(db, {
        id: optId(b.id),
        kind: kind(b.kind),
        name: str(b.name, "name", 80),
        plannedCents: int(b.plannedCents ?? 0, "plannedCents", 0),
        sort: int(b.sort ?? 0, "sort"),
        archived: Boolean(b.archived),
        group: b.group == null ? undefined : expenseGroup(b.group),
        accountId: b.accountId === undefined ? undefined : b.accountId === null ? null : int(b.accountId, "accountId", 1),
      }),
    );
  });
  api.delete("/categories/:id", (req, res) => {
    store.deleteCategory(db, idParam(req));
    res.json({ ok: true });
  });

  // Ids of accounts that exist (entries, transfers and savings can point at one).
  const accountId = (v: unknown, field: string): number => {
    const id = int(v, field, 1);
    if (!store.listAccounts(db).some((a) => a.id === id)) throw new BadRequest(`invalid ${field}`);
    return id;
  };

  const expenseCategoryId = (v: unknown): number => {
    const id = int(v, "categoryId", 1);
    if (!store.listCategories(db).some((c) => c.id === id && c.kind === "expense"))
      throw new BadRequest("invalid categoryId");
    return id;
  };

  // Transactions
  api.get("/transactions", (req, res) => {
    const start = monthStartOf(store.getSettings(db));
    const range = req.query.month ? periodRange(monthStr(req.query.month), start) : {};
    res.json(
      store.listTransactions(db, {
        ...range,
        kind: req.query.kind ? kind(req.query.kind) : undefined,
        accountId: req.query.account ? int(Number(req.query.account), "account", 1) : undefined,
      }),
    );
  });
  // Subscription debits still to come in a month, shown next to its entries.
  api.get("/transactions/upcoming", (req, res) => {
    const { from, to } = periodRange(monthStr(req.query.month), monthStartOf(store.getSettings(db)));
    res.json(upcomingDebits(db, from, to, todayISO()));
  });
  api.post("/transactions", (req, res) => {
    const b = req.body ?? {};
    // Unpaid expenses don't count in their month, so only paid ones are locked.
    const old = dateOf("transactions", optId(b.id), ", paid");
    ensureOpen((b.kind === "income" || b.paid !== false) && dateStr(b.date), old?.paid && old.date);
    res.json(
      store.saveTransaction(db, {
        id: optId(b.id),
        kind: kind(b.kind),
        date: dateStr(b.date),
        amountCents: int(b.amountCents, "amountCents", 0),
        description: str(b.description ?? "", "description"),
        categoryId: b.categoryId == null ? null : int(b.categoryId, "categoryId", 1),
        paid: b.paid !== false,
        accountId: b.accountId == null ? null : accountId(b.accountId, "accountId"),
      }),
    );
  });
  api.post("/transactions/:id/pay", (req, res) => {
    ensureOpen(dateStr(req.body?.date));
    const t = store.payTransaction(db, idParam(req), dateStr(req.body?.date));
    if (!t) return res.status(404).json({ error: "not_found" });
    res.json(t);
  });
  api.delete("/transactions/:id", (req, res) => {
    const old = dateOf("transactions", idParam(req), ", paid");
    ensureOpen(old?.paid && old.date);
    const result = store.deleteTransaction(db, idParam(req));
    if (result === "installment") return res.status(409).json({ error: "installment" });
    res.json({ ok: true, result });
  });

  // Purchases paid in installments
  api.get("/installments", (_req, res) => {
    res.json(store.listInstallmentPlans(db));
  });
  api.post("/installments", (req, res) => {
    const b = req.body ?? {};
    const totalCents = int(b.totalCents, "totalCents", 1);
    const count = int(b.count, "count", 2, 48);
    if (totalCents < count) throw new BadRequest("invalid totalCents");
    ensureOpen(b.firstPaid === true && dateStr(b.firstDate, "firstDate"));
    res.json(
      store.createInstallmentPlan(db, {
        name: str(b.name, "name", 200),
        totalCents,
        count,
        everyDays: b.everyDays == null ? null : int(b.everyDays, "everyDays", 1, 366),
        categoryId: b.categoryId == null ? null : int(b.categoryId, "categoryId", 1),
        accountId: b.accountId == null ? null : accountId(b.accountId, "accountId"),
        firstDate: dateStr(b.firstDate, "firstDate"),
        firstPaid: b.firstPaid === true,
      }),
    );
  });
  api.delete("/installments/:id", (req, res) => {
    ensureOpen(...datesOf("SELECT date FROM transactions WHERE plan_id = ? AND paid = 1", idParam(req)));
    store.deleteInstallmentPlan(db, idParam(req));
    res.json({ ok: true });
  });
  // Accounts and transfers between them
  api.get("/accounts", (_req, res) => {
    res.json(store.listAccounts(db));
  });
  api.post("/accounts", (req, res) => {
    const b = req.body ?? {};
    const name = str(b.name, "name", 80);
    const id0 = b.id == null ? undefined : accountId(b.id, "id");
    if (!name) throw new BadRequest("invalid name");
    if (store.listAccounts(db).some((a) => a.id !== id0 && a.name.toLowerCase() === name.toLowerCase()))
      throw new BadRequest("duplicate_name");
    const id = store.saveAccount(db, {
      id: id0,
      name,
      openingCents: int(b.openingCents ?? 0, "openingCents"),
      isDefault: Boolean(b.isDefault),
      sort: int(b.sort ?? 0, "sort"),
      archived: Boolean(b.archived),
    });
    res.json({ id });
  });
  api.delete("/accounts/:id", (req, res) => {
    // The default account and accounts with transfers can only be archived.
    if (!store.deleteAccount(db, idParam(req))) throw new BadRequest("account_in_use");
    res.json({ ok: true });
  });
  api.get("/transfers", (req, res) => {
    const start = monthStartOf(store.getSettings(db));
    const range = req.query.month ? periodRange(monthStr(req.query.month), start) : {};
    res.json(store.listTransfers(db, range));
  });
  api.post("/transfers", (req, res) => {
    const b = req.body ?? {};
    const fromAccountId = accountId(b.fromAccountId, "fromAccountId");
    const toAccountId = accountId(b.toAccountId, "toAccountId");
    if (fromAccountId === toAccountId) throw new BadRequest("same account");
    ensureOpen(dateStr(b.date), dateOf("transfers", optId(b.id))?.date);
    const id = store.saveTransfer(db, {
      id: optId(b.id),
      date: dateStr(b.date),
      amountCents: int(b.amountCents, "amountCents", 1),
      fromAccountId,
      toAccountId,
      note: str(b.note ?? "", "note"),
    });
    res.json({ id });
  });
  // What to move from the salary account to each other account for a budget month.
  api.get("/transfer-plan", (req, res) => {
    res.json(transferPlan(db, monthStr(req.query.month)));
  });
  // Records the month's transfer to one account; only once per month and account.
  api.post("/transfer-plan/confirm", (req, res) => {
    const b = req.body ?? {};
    const month = monthStr(b.month);
    const plan = transferPlan(db, month);
    const toAccountId = accountId(b.toAccountId, "toAccountId");
    if (toAccountId === plan.salaryAccountId) throw new BadRequest("same account");
    ensureOpen(dateStr(b.date));
    if (plan.needs.some((n) => n.accountId === toAccountId && n.transfer))
      return res.status(409).json({ error: "already_done" });
    const id = store.saveTransfer(db, {
      date: dateStr(b.date),
      amountCents: int(b.amountCents, "amountCents", 1),
      fromAccountId: plan.salaryAccountId,
      toAccountId,
      note: str(b.note ?? "", "note"),
      budgetMonth: month,
    });
    res.json({ id });
  });
  api.delete("/transfers/:id", (req, res) => {
    ensureOpen(dateOf("transfers", idParam(req))?.date);
    store.deleteTransfer(db, idParam(req));
    res.json({ ok: true });
  });

  // Savings
  api.get("/savings", (_req, res) => {
    res.json({ pots: store.listPots(db), movements: store.listMovements(db) });
  });
  api.post("/savings/pots", (req, res) => {
    const b = req.body ?? {};
    const id = store.savePot(db, {
      id: optId(b.id),
      name: str(b.name, "name", 80),
      goalCents: int(b.goalCents ?? 0, "goalCents", 0),
      sort: int(b.sort ?? 0, "sort"),
    });
    res.json({ id });
  });
  api.delete("/savings/pots/:id", (req, res) => {
    ensureOpen(...datesOf("SELECT date FROM savings_movements WHERE pot_id = ?", idParam(req)));
    store.deletePot(db, idParam(req));
    res.json({ ok: true });
  });
  api.post("/savings/movements", (req, res) => {
    const b = req.body ?? {};
    ensureOpen(dateStr(b.date), dateOf("savings_movements", optId(b.id))?.date);
    const id = store.saveMovement(db, {
      id: optId(b.id),
      potId: int(b.potId, "potId", 1),
      date: dateStr(b.date),
      amountCents: int(b.amountCents, "amountCents"),
      place: str(b.place ?? "", "place", 80),
      note: str(b.note ?? "", "note"),
      opening: Boolean(b.opening),
      accountId: b.accountId == null ? null : accountId(b.accountId, "accountId"),
    });
    res.json({ id });
  });
  api.delete("/savings/movements/:id", (req, res) => {
    ensureOpen(dateOf("savings_movements", idParam(req))?.date);
    store.deleteMovement(db, idParam(req));
    res.json({ ok: true });
  });

  // Plan
  api.get("/plan", (_req, res) => {
    res.json({
      settings: store.getSettings(db),
      items: store.listPlanItems(db),
      loans: store.listLoans(db),
      babySteps: computeBabySteps(db),
      babyStepSettings: store.getBabyStepSettings(db),
    });
  });
  api.post("/plan/items", (req, res) => {
    const b = req.body ?? {};
    const id = store.savePlanItem(db, {
      id: optId(b.id),
      section: section(b.section),
      name: str(b.name, "name", 80),
      amountCents: int(b.amountCents ?? 0, "amountCents", 0),
      month: b.month == null ? null : int(b.month, "month", 1, 12),
      sort: int(b.sort ?? 0, "sort"),
      debitDay: b.debitDay == null ? null : int(b.debitDay, "debitDay", 1, 31),
      categoryId: b.categoryId == null ? null : expenseCategoryId(b.categoryId),
      accountId: b.accountId == null ? null : accountId(b.accountId, "accountId"),
    });
    // Setting today's day adds the expense straight away.
    chargeSubscriptions(db, todayISO());
    res.json({ id });
  });
  api.delete("/plan/items/:id", (req, res) => {
    store.deletePlanItem(db, idParam(req));
    res.json({ ok: true });
  });
  api.post("/plan/loans", (req, res) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.amortizations) || b.amortizations.length > 50)
      throw new BadRequest("invalid amortizations");
    const id = store.saveLoan(db, {
      id: optId(b.id),
      name: str(b.name, "name", 80),
      principalCents: int(b.principalCents ?? 0, "principalCents", 0),
      monthlyCents: int(b.monthlyCents ?? 0, "monthlyCents", 0),
      paidOff: Boolean(b.paidOff),
      mortgage: Boolean(b.mortgage),
      sort: int(b.sort ?? 0, "sort"),
      accountId: b.accountId === undefined ? undefined : b.accountId == null ? null : accountId(b.accountId, "accountId"),
      amortizations: b.amortizations.map((a: { year: unknown; amountCents: unknown }) => ({
        year: int(a.year, "year", 1900, 2200),
        amountCents: int(a.amountCents, "amountCents", 0),
      })),
    });
    res.json({ id });
  });
  // The account a loan's monthly payment leaves from, picked on the Plan.
  api.put("/plan/loans/:id/account", (req, res) => {
    const id = idParam(req);
    if (!store.listLoans(db).some((l) => l.id === id)) return res.status(404).json({ error: "not_found" });
    const b = req.body ?? {};
    store.setLoanAccount(db, id, b.accountId == null ? null : accountId(b.accountId, "accountId"));
    res.json({ ok: true });
  });
  api.delete("/plan/loans/:id", (req, res) => {
    store.deleteLoan(db, idParam(req));
    res.json({ ok: true });
  });
  api.get("/baby-steps/settings", (_req, res) => {
    res.json({ settings: store.getBabyStepSettings(db), pots: store.listPots(db) });
  });
  api.put("/baby-steps/settings", (req, res) => {
    const b = req.body ?? {};
    const potId = (v: unknown, field: string) => (v == null ? null : int(v, field, 1));
    res.json(
      store.updateBabyStepSettings(db, {
        emergencyPotId: b.emergencyPotId === undefined ? undefined : potId(b.emergencyPotId, "emergencyPotId"),
        starterFundCents: b.starterFundCents === undefined ? undefined : int(b.starterFundCents, "starterFundCents", 0),
        emergencyMonths: b.emergencyMonths === undefined ? undefined : int(b.emergencyMonths, "emergencyMonths", 1, 24),
        investPercent: b.investPercent === undefined ? undefined : int(b.investPercent, "investPercent", 0, 100),
        educationPotId: b.educationPotId === undefined ? undefined : potId(b.educationPotId, "educationPotId"),
      }),
    );
  });

  // Loans page: bank loans, money lent to or borrowed from people, and purchases in installments
  api.get("/loans", (_req, res) => {
    res.json({
      loans: store.listLoans(db),
      personal: store.listPersonalLoans(db),
      installments: store.listInstallmentPlans(db),
    });
  });
  api.post("/loans/personal", (req, res) => {
    const b = req.body ?? {};
    ensureOpen(dateStr(b.date), dateOf("personal_loans", optId(b.id))?.date);
    const id = store.savePersonalLoan(db, {
      id: optId(b.id),
      person: str(b.person, "person", 80),
      direction: direction(b.direction),
      date: dateStr(b.date),
      amountCents: int(b.amountCents, "amountCents", 1),
      dueDate: b.dueDate == null || b.dueDate === "" ? null : dateStr(b.dueDate, "dueDate"),
      note: str(b.note ?? "", "note"),
      // Only used for a new loan: the account the money came into or left.
      accountId: b.accountId == null ? null : int(b.accountId, "accountId", 1),
    });
    res.json({ id });
  });
  api.delete("/loans/personal/:id", (req, res) => {
    const id = idParam(req);
    ensureOpen(dateOf("personal_loans", id)?.date, ...datesOf("SELECT date FROM personal_loan_payments WHERE loan_id = ?", id));
    store.deletePersonalLoan(db, idParam(req));
    res.json({ ok: true });
  });
  api.post("/loans/payments", (req, res) => {
    const b = req.body ?? {};
    ensureOpen(dateStr(b.date), dateOf("personal_loan_payments", optId(b.id))?.date);
    const id = store.savePersonalLoanPayment(db, {
      id: optId(b.id),
      loanId: int(b.loanId, "loanId", 1),
      date: dateStr(b.date),
      amountCents: int(b.amountCents, "amountCents", 1),
      note: str(b.note ?? "", "note"),
    });
    res.json({ id });
  });
  api.post("/loans/personal/pay", (req, res) => {
    const b = req.body ?? {};
    ensureOpen(dateStr(b.date));
    const result = store.payPerson(db, {
      person: str(b.person, "person", 80),
      direction: direction(b.direction),
      date: dateStr(b.date),
      amountCents: int(b.amountCents, "amountCents", 1),
      note: str(b.note ?? "", "note"),
      accountId: b.accountId == null ? null : int(b.accountId, "accountId", 1),
    });
    if (!result) throw new BadRequest("more_than_owed");
    res.json(result);
  });
  api.get("/loans/moves", (req, res) => {
    const { from, to } = periodRange(monthStr(req.query.month), monthStartOf(store.getSettings(db)));
    res.json(store.listLoanMoves(db, from, to));
  });
  api.delete("/loans/payment-batches/:batch", (req, res) => {
    ensureOpen(...datesOf("SELECT date FROM personal_loan_payments WHERE batch = ?", str(req.params.batch, "batch", 64)));
    store.deletePaymentBatch(db, str(req.params.batch, "batch", 64));
    res.json({ ok: true });
  });
  api.delete("/loans/payments/:id", (req, res) => {
    ensureOpen(dateOf("personal_loan_payments", idParam(req))?.date);
    store.deletePersonalLoanPayment(db, idParam(req));
    res.json({ ok: true });
  });

  // Reports
  api.get("/summary", (req, res) => {
    res.json(monthSummary(db, monthStr(req.query.month)));
  });
  api.get("/plan-grid", (req, res) => {
    const count = req.query.count === undefined ? 12 : int(Number(req.query.count), "count", 1, 36);
    res.json(planGrid(db, monthStr(req.query.from), count));
  });
  api.post("/month-plans", (req, res) => {
    const b = req.body ?? {};
    if (store.getClose(db, monthStr(b.month))) throw new MonthClosed();
    store.setMonthPlan(
      db,
      monthStr(b.month),
      b.categoryId == null ? null : int(b.categoryId, "categoryId", 1),
      b.cents == null ? null : int(b.cents, "cents", 0),
    );
    res.json({ ok: true });
  });
  // Closing a month: where its leftover goes, the bank balances, and the lock.
  api.post("/month-close", (req, res) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.balances) || b.balances.length > 50) throw new BadRequest("invalid balances");
    res.json(
      closeMonth(db, {
        month: monthStr(b.month),
        action: closeAction(b.action),
        potId: b.potId == null ? null : int(b.potId, "potId", 1),
        potCents: int(b.potCents ?? 0, "potCents", 0),
        accountId: b.accountId == null ? null : accountId(b.accountId, "accountId"),
        balances: b.balances.map((x: { accountId: unknown; bankCents: unknown }) => ({
          accountId: accountId(x.accountId, "accountId"),
          bankCents: int(x.bankCents, "bankCents"),
        })),
      }),
    );
  });
  api.delete("/month-close/:month", (req, res) => {
    reopenMonth(db, monthStr(req.params.month));
    res.json({ ok: true });
  });
  api.get("/overview", (req, res) => {
    const today = req.query.today === undefined ? todayISO() : dateStr(req.query.today, "today");
    res.json(overview(db, monthStr(req.query.month), today));
  });
  api.get("/balance", (_req, res) => {
    res.json(balanceReport(db));
  });

  // Import and backup
  api.post(
    "/import",
    express.raw({ type: "application/octet-stream", limit: "30mb" }),
    async (req: Request, res: Response) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new BadRequest("empty file");
      try {
        res.json(await importWorkbook(db, req.body));
      } catch (err) {
        res.status(400).json({ error: "import_failed", detail: String((err as Error).message) });
      }
    },
  );
  // Bank statements: the file is only read here; lines are saved once confirmed in the app.
  api.post(
    "/bank-import/preview",
    express.raw({ type: "application/octet-stream", limit: "10mb" }),
    async (req: Request, res: Response) => {
      const account = accountId(Number(req.query.account), "account");
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new BadRequest("empty file");
      try {
        res.json(await previewStatement(db, account, req.body));
      } catch (err) {
        if (err instanceof StatementError) throw new BadRequest(err.message);
        throw err;
      }
    },
  );
  api.post("/bank-import/commit", (req, res) => {
    const b = req.body ?? {};
    const account = accountId(b.accountId, "accountId");
    if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > 3000) throw new BadRequest("invalid lines");
    const categories = store.listCategories(db);
    const pots = store.listPots(db);
    const lines = b.lines.map((l: Record<string, unknown>) => {
      const amountCents = int(l.amountCents, "amountCents");
      if (amountCents === 0) throw new BadRequest("invalid amountCents");
      const categoryId = l.categoryId == null ? null : int(l.categoryId, "categoryId", 1);
      const kind = amountCents < 0 ? "expense" : "income";
      if (categoryId != null && !categories.some((c) => c.id === categoryId && c.kind === kind))
        throw new BadRequest("invalid categoryId");
      const transferAccountId = l.transferAccountId == null ? null : accountId(l.transferAccountId, "transferAccountId");
      if (transferAccountId === account) throw new BadRequest("same account");
      const potId = l.potId == null ? null : int(l.potId, "potId", 1);
      if (potId != null && !pots.some((p) => p.id === potId)) throw new BadRequest("invalid potId");
      const loan = l.loan == null ? null : (l.loan as Record<string, unknown>);
      const person = loan == null ? "" : str(loan.person, "person", 80);
      if (loan != null && !person) throw new BadRequest("invalid person");
      ensureOpen(dateStr(l.date));
      return {
        date: dateStr(l.date),
        description: str(l.description ?? "", "description"),
        amountCents,
        categoryId,
        transferAccountId,
        potId,
        loan: loan == null ? null : { person, repay: loan.repay === true },
      };
    });
    try {
      res.json(commitStatement(db, account, lines));
    } catch (err) {
      if (err instanceof StatementError) throw new BadRequest(err.message);
      throw err;
    }
  });

  api.get("/backup", (_req, res) => {
    const file = join(tmpdir(), `budget-backup-${Date.now()}.db`);
    db.prepare("VACUUM INTO ?").run(file);
    const data = readFileSync(file);
    rmSync(file, { force: true });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.sqlite3");
    res.setHeader("Content-Disposition", `attachment; filename="budget-${stamp}.db"`);
    res.send(data);
  });

  // Deletes all financial data; asks for the password again so a stray tap can't do it.
  api.post("/wipe", (req, res) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!passwordMatches(password, opts.password)) {
      res.status(401).json({ error: "wrong_password" });
      return;
    }
    store.wipeData(db);
    res.json({ ok: true });
  });

  api.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  api.use((err: unknown, _req: Request, res: Response, _next: unknown) => {
    if (err instanceof MonthClosed) {
      res.status(409).json({ error: "month_closed" });
      return;
    }
    if (err instanceof BadRequest || err instanceof CloseError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "server_error" });
  });

  app.use("/api", api);

  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false, maxAge: "1h" }));
    app.get(/.*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(join(opts.staticDir!, "index.html"));
    });
  }

  return app;
}
