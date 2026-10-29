import type { DB } from "./db.ts";
import { getSetting, guessExpenseGroup, setSetting, tx } from "./db.ts";
import { installmentDate, monthOf, monthStartOf, todayISO } from "../shared/period.ts";
import { descriptionKey } from "../shared/describe.ts";
import type {
  Account,
  BabyStepSettings,
  Category,
  CategoryHint,
  InstallmentPlan,
  Kind,
  Loan,
  LoanMove,
  MonthClose,
  PersonalLoan,
  PersonalLoanDirection,
  PersonalLoanPayment,
  PlanItem,
  PlanSection,
  SavingsMovement,
  SavingsPot,
  Settings,
  ToConfirm,
  Transaction,
  Transfer,
  ExpenseGroup,
} from "../shared/types.ts";

type Row = Record<string, unknown>;

const toCategory = (r: Row): Category => ({
  id: Number(r.id),
  kind: r.kind as Kind,
  name: String(r.name),
  plannedCents: Number(r.planned_cents),
  sort: Number(r.sort),
  archived: Boolean(r.archived),
  group: (r.expense_group ?? "variable") as ExpenseGroup,
  accountId: r.account_id == null ? null : Number(r.account_id),
});

const toTransaction = (r: Row): Transaction => ({
  id: Number(r.id),
  kind: r.kind as Kind,
  date: String(r.date),
  amountCents: Number(r.amount_cents),
  description: String(r.description),
  categoryId: r.category_id == null ? null : Number(r.category_id),
  paid: Boolean(r.paid),
  scheduled: Boolean(r.scheduled),
  accountId: Number(r.account_id),
  installment:
    r.plan_id == null
      ? null
      : { planId: Number(r.plan_id), seq: Number(r.plan_seq), count: Number(r.plan_count) },
});

// Transactions with their account (no account = the default one) and the
// installment count of their purchase, if any.
const TX_SELECT = `SELECT t.*, COALESCE(t.account_id, (SELECT id FROM accounts WHERE is_default = 1)) AS account_id,
  p.count AS plan_count FROM transactions t LEFT JOIN installment_plans p ON p.id = t.plan_id`;

// Settings

export function getSettings(db: DB): Settings {
  return {
    salaryCents: Number(getSetting(db, "salary_cents", "0")),
    monthStartMode:
      getSetting(db, "month_start_mode", "lastBusinessDay") === "fixedDay" ? "fixedDay" : "lastBusinessDay",
    monthStartDay: Number(getSetting(db, "month_start_day", "25")),
    plannedSavingsCents: Number(getSetting(db, "planned_savings_cents", "0")),
    salaryAccountId: getSetting(db, "salary_account_id", "") ? Number(getSetting(db, "salary_account_id", "")) : null,
  };
}

export function updateSettings(db: DB, s: Partial<Settings>): Settings {
  if (s.salaryCents !== undefined) setSetting(db, "salary_cents", String(s.salaryCents));
  if (s.monthStartMode !== undefined) setSetting(db, "month_start_mode", s.monthStartMode);
  if (s.monthStartDay !== undefined) setSetting(db, "month_start_day", String(s.monthStartDay));
  if (s.plannedSavingsCents !== undefined)
    setSetting(db, "planned_savings_cents", String(s.plannedSavingsCents));
  if (s.salaryAccountId !== undefined)
    setSetting(db, "salary_account_id", s.salaryAccountId == null ? "" : String(s.salaryAccountId));
  return getSettings(db);
}

// Planned amounts per budget month

export interface MonthPlans {
  categories: Map<number, number>;
  savingsCents: number | null;
}

/** The planned amounts set for one month, on top of each category's usual one. */
export function monthPlans(db: DB, month: string): MonthPlans {
  const rows = db.prepare("SELECT category_id, planned_cents FROM category_month_plans WHERE month = ?").all(month) as {
    category_id: number;
    planned_cents: number;
  }[];
  const savings = db.prepare("SELECT planned_cents FROM savings_month_plans WHERE month = ?").get(month) as
    | { planned_cents: number }
    | undefined;
  return {
    categories: new Map(rows.map((r) => [Number(r.category_id), Number(r.planned_cents)])),
    savingsCents: savings ? Number(savings.planned_cents) : null,
  };
}

/** Sets what is planned for a category (or savings, with no category) in one month; null goes back to the usual amount. */
export function setMonthPlan(db: DB, month: string, categoryId: number | null, cents: number | null): void {
  if (categoryId == null) {
    if (cents == null) db.prepare("DELETE FROM savings_month_plans WHERE month = ?").run(month);
    else
      db.prepare(
        "INSERT INTO savings_month_plans (month, planned_cents) VALUES (?, ?) ON CONFLICT(month) DO UPDATE SET planned_cents = excluded.planned_cents",
      ).run(month, cents);
    return;
  }
  if (cents == null) db.prepare("DELETE FROM category_month_plans WHERE category_id = ? AND month = ?").run(categoryId, month);
  else
    db.prepare(
      `INSERT INTO category_month_plans (category_id, month, planned_cents) VALUES (?, ?, ?)
       ON CONFLICT(category_id, month) DO UPDATE SET planned_cents = excluded.planned_cents`,
    ).run(categoryId, month, cents);
}

// Categories

export function listCategories(db: DB): Category[] {
  return (db.prepare("SELECT * FROM categories ORDER BY kind, sort, name").all() as Row[]).map(
    toCategory,
  );
}

export function upsertCategory(
  db: DB,
  c: Omit<Category, "id" | "group" | "accountId"> & { id?: number; group?: ExpenseGroup; accountId?: number | null },
): Category {
  if (c.id) {
    db.prepare(
      "UPDATE categories SET name = ?, planned_cents = ?, sort = ?, archived = ?, expense_group = COALESCE(?, expense_group), account_id = CASE WHEN ? THEN ? ELSE account_id END WHERE id = ?",
    ).run(c.name, c.plannedCents, c.sort, c.archived ? 1 : 0, c.group ?? null, c.accountId === undefined ? 0 : 1, c.accountId ?? null, c.id);
    return toCategory(db.prepare("SELECT * FROM categories WHERE id = ?").get(c.id) as Row);
  }
  const res = db
    .prepare(
      "INSERT INTO categories (kind, name, planned_cents, sort, archived, expense_group, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      c.kind,
      c.name,
      c.plannedCents,
      c.sort,
      c.archived ? 1 : 0,
      c.group ?? (c.kind === "expense" ? guessExpenseGroup(c.name) : "variable"),
      c.accountId ?? null,
    );
  return toCategory(
    db.prepare("SELECT * FROM categories WHERE id = ?").get(Number(res.lastInsertRowid)) as Row,
  );
}

export function deleteCategory(db: DB, id: number): void {
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);
}

/** Finds a category by name (case-insensitive), creating it when missing. */
export function ensureCategory(db: DB, kind: Kind, name: string, plannedCents = 0): number {
  const found = db
    .prepare("SELECT id FROM categories WHERE kind = ? AND lower(name) = lower(?)")
    .get(kind, name) as { id: number } | undefined;
  if (found) return Number(found.id);
  const sort = (
    db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories WHERE kind = ?").get(kind) as {
      s: number;
    }
  ).s;
  return upsertCategory(db, { kind, name, plannedCents, sort, archived: false }).id;
}

// Transactions

// Entries with no account belong to the default one.
const ACCOUNT_OF = "COALESCE(account_id, (SELECT id FROM accounts WHERE is_default = 1))";

export function listTransactions(
  db: DB,
  opts: { from?: string; to?: string; kind?: Kind; accountId?: number },
): Transaction[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.accountId) {
    where.push(`${ACCOUNT_OF} = ?`);
    params.push(opts.accountId);
  }
  if (opts.from) {
    where.push("t.date >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    where.push("t.date < ?");
    params.push(opts.to);
  }
  if (opts.kind) {
    where.push("t.kind = ?");
    params.push(opts.kind);
  }
  const sql = `${TX_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t.date DESC, t.id DESC`;
  return (db.prepare(sql).all(...params) as Row[]).map(toTransaction);
}

/**
 * For each kind and description key, the category of the latest entry with it,
 * so a repeated shop comes with its category already picked. Newest first.
 */
export function categoryHints(db: DB): CategoryHint[] {
  const rows = db
    .prepare(
      `SELECT t.kind, t.description, t.category_id FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE c.archived = 0 AND t.description <> '' ORDER BY t.date DESC, t.id DESC`,
    )
    .all() as { kind: Kind; description: string; category_id: number }[];
  const hints = new Map<string, CategoryHint>();
  for (const r of rows) {
    const key = `${r.kind}|${descriptionKey(r.description)}`;
    if (!key.endsWith("|") && !hints.has(key))
      hints.set(key, { kind: r.kind, description: r.description, categoryId: Number(r.category_id) });
  }
  return [...hints.values()];
}

/**
 * Whether a row dated `date` waits for its day and a confirmation that it went
 * through: it is dated after today, or it was already waiting and its date is
 * left as it was.
 */
function waits(db: DB, table: string, id: number | undefined, date: string, today: string): 0 | 1 {
  if (date > today) return 1;
  const old = id ? (db.prepare(`SELECT date, scheduled FROM ${table} WHERE id = ?`).get(id) as { date: string; scheduled: number } | undefined) : undefined;
  return old?.scheduled === 1 && old.date === date ? 1 : 0;
}

export function saveTransaction(
  db: DB,
  t: Omit<Transaction, "id" | "paid" | "scheduled" | "accountId" | "installment"> & { id?: number; paid?: boolean; accountId?: number | null },
  today = todayISO(),
): Transaction {
  let id = t.id;
  const old = id
    ? (db.prepare("SELECT date, scheduled, plan_id FROM transactions WHERE id = ?").get(id) as
        | { date: string; scheduled: number; plan_id: number | null }
        | undefined)
    : undefined;
  // An entry dated after today waits for its day and a confirmation that it was
  // debited, and so does one still waiting whose date is left as it was.
  // Installments follow their purchase instead.
  const scheduled =
    old?.plan_id == null && (t.date > today || (old?.scheduled === 1 && old.date === t.date)) ? 1 : 0;
  // Only expenses can be left unpaid.
  const paid = !scheduled && (t.kind === "income" || t.paid !== false) ? 1 : 0;
  const accountId = t.accountId ?? null;
  if (id) {
    db.prepare(
      "UPDATE transactions SET kind = ?, date = ?, amount_cents = ?, description = ?, category_id = ?, paid = ?, scheduled = ?, account_id = ? WHERE id = ?",
    ).run(t.kind, t.date, t.amountCents, t.description, t.categoryId, paid, scheduled, accountId, id);
  } else {
    id = Number(
      db
        .prepare(
          "INSERT INTO transactions (kind, date, amount_cents, description, category_id, paid, scheduled, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(t.kind, t.date, t.amountCents, t.description, t.categoryId, paid, scheduled, accountId).lastInsertRowid,
    );
  }
  return getTransaction(db, id)!;
}

function getTransaction(db: DB, id: number): Transaction | null {
  const row = db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
  return row ? toTransaction(row) : null;
}

/** Marks an unpaid expense as paid on the given date, so it counts in that month. */
export function payTransaction(db: DB, id: number, date: string): Transaction | null {
  db.prepare("UPDATE transactions SET paid = 1, scheduled = 0, date = ? WHERE id = ? AND paid = 0").run(date, id);
  return getTransaction(db, id);
}

/** Unpaid expenses due before `to`, oldest first: what is still to pay by the end of a month. */
export function listPending(db: DB, to: string): Transaction[] {
  return (
    db
      .prepare(`${TX_SELECT} WHERE t.kind = 'expense' AND t.paid = 0 AND t.date < ? ORDER BY t.date, t.id`)
      .all(to) as Row[]
  ).map(toTransaction);
}

/**
 * Everything dated ahead whose day has come, oldest first: entries, transfers,
 * savings movements, personal loans and repayments. The app asks if they went through.
 */
export function listToConfirm(db: DB, today = todayISO()): ToConfirm[] {
  const none = { entry: null, person: null, potId: null, fromAccountId: null, toAccountId: null };
  const out: ToConfirm[] = [];
  for (const r of db.prepare(`${TX_SELECT} WHERE t.scheduled = 1 AND t.date <= ?`).all(today) as Row[]) {
    const t = toTransaction(r);
    out.push({ ...none, type: "entry", key: String(t.id), date: t.date, amountCents: t.kind === "expense" ? -t.amountCents : t.amountCents, accountId: t.accountId, entry: t, label: t.description });
  }
  for (const r of db.prepare("SELECT * FROM transfers WHERE scheduled = 1 AND date <= ?").all(today) as Row[])
    out.push({ ...none, type: "transfer", key: String(r.id), date: String(r.date), amountCents: Number(r.amount_cents), accountId: null, label: String(r.note), fromAccountId: Number(r.from_account_id), toAccountId: Number(r.to_account_id) });
  const savings = db
    .prepare("SELECT m.*, p.name AS pot FROM savings_movements m JOIN savings_pots p ON p.id = m.pot_id WHERE m.scheduled = 1 AND m.date <= ?")
    .all(today) as Row[];
  for (const r of savings)
    // A deposit leaves the account, a withdrawal comes back to it.
    out.push({ ...none, type: "savings", key: String(r.id), date: String(r.date), amountCents: -Number(r.amount_cents), accountId: r.account_id == null ? null : Number(r.account_id), label: String(r.pot), potId: Number(r.pot_id) });
  for (const r of db.prepare("SELECT * FROM personal_loans WHERE scheduled = 1 AND date <= ?").all(today) as Row[])
    out.push({ ...none, type: "loan", key: String(r.id), date: String(r.date), amountCents: r.direction === "borrowed" ? Number(r.amount_cents) : -Number(r.amount_cents), accountId: r.account_id == null ? null : Number(r.account_id), label: String(r.note), person: String(r.person).trim() });
  const repayments = db
    .prepare(
      `SELECT COALESCE('b' || p.batch, '#' || p.id) AS key, MIN(p.date) AS date, l.person, l.direction, SUM(p.amount_cents) AS cents, p.account_id, p.note
         FROM personal_loan_payments p JOIN personal_loans l ON l.id = p.loan_id
        WHERE p.scheduled = 1 AND p.date <= ? GROUP BY key`,
    )
    .all(today) as Row[];
  for (const r of repayments)
    out.push({ ...none, type: "repayment", key: String(r.key), date: String(r.date), amountCents: r.direction === "lent" ? Number(r.cents) : -Number(r.cents), accountId: r.account_id == null ? null : Number(r.account_id), label: String(r.note), person: String(r.person).trim() });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

const CONFIRM_TABLES = { transfer: "transfers", savings: "savings_movements", loan: "personal_loans", repayment: "personal_loan_payments" } as const;

/** The table and rows behind something to confirm (a split repayment is all of its parts). */
export function confirmTarget(type: keyof typeof CONFIRM_TABLES, key: string): { table: string; where: string; param: string | number } {
  const table = CONFIRM_TABLES[type];
  if (type === "repayment" && key.startsWith("b")) return { table, where: "batch = ?", param: key.slice(1) };
  return { table, where: "id = ?", param: Number(key.replace(/^#/, "")) };
}

/**
 * Answers whether a transfer, savings movement, loan or repayment dated ahead
 * went through on its day. Yes: it counts on that date. No: it is expected the next day.
 */
export function confirmScheduled(db: DB, type: keyof typeof CONFIRM_TABLES, key: string, done: boolean, today = todayISO()): void {
  const { table, where, param } = confirmTarget(type, key);
  const due = `${where} AND scheduled = 1 AND date <= ?`;
  if (done) db.prepare(`UPDATE ${table} SET scheduled = 0 WHERE ${due}`).run(param, today);
  else db.prepare(`UPDATE ${table} SET date = ? WHERE ${due}`).run(installmentDate(today, 1, 1), param, today);
}

/**
 * Answers whether an entry dated ahead went through on its day. Yes: it counts
 * on that date. No: an expense becomes still to pay, and income is expected
 * again the next day.
 */
export function confirmTransaction(db: DB, id: number, done: boolean, today = todayISO()): Transaction | null {
  const row = db.prepare("SELECT kind, date FROM transactions WHERE id = ? AND scheduled = 1").get(id) as
    | { kind: Kind; date: string }
    | undefined;
  if (row && row.date <= today) {
    if (done) db.prepare("UPDATE transactions SET paid = 1, scheduled = 0 WHERE id = ?").run(id);
    else if (row.kind === "expense") db.prepare("UPDATE transactions SET scheduled = 0 WHERE id = ?").run(id);
    else db.prepare("UPDATE transactions SET date = ? WHERE id = ?").run(installmentDate(today, 1, 1), id);
  }
  return getTransaction(db, id);
}

/**
 * Deletes an entry. An installment is never removed from its purchase, as it
 * is still owed: a paid one goes back to still to pay on its due date
 * ("unpaid"), and an unpaid one is left alone ("installment"); the whole
 * purchase is deleted from Loans instead.
 */
export function deleteTransaction(db: DB, id: number): "deleted" | "unpaid" | "installment" {
  const row = db
    .prepare(
      `SELECT t.paid, t.plan_seq, p.first_date, p.every_days FROM transactions t
       LEFT JOIN installment_plans p ON p.id = t.plan_id WHERE t.id = ? AND t.plan_id IS NOT NULL`,
    )
    .get(id) as { paid: number; plan_seq: number; first_date: string; every_days: number | null } | undefined;
  if (!row) {
    db.prepare("DELETE FROM transactions WHERE id = ?").run(id);
    return "deleted";
  }
  if (!row.paid) return "installment";
  const due = installmentDate(row.first_date, row.plan_seq - 1, row.every_days);
  db.prepare("UPDATE transactions SET paid = 0, date = ? WHERE id = ?").run(due, id);
  return "unpaid";
}

// Installments

/**
 * Splits a purchase into `count` unpaid expenses on their due dates. The
 * cents that do not split evenly go on the last one. With `firstPaid`, the
 * first installment counts as paid on its date (paid at checkout).
 */
export function createInstallmentPlan(
  db: DB,
  p: {
    name: string;
    totalCents: number;
    count: number;
    everyDays: number | null;
    categoryId: number | null;
    accountId: number | null;
    firstDate: string;
    firstPaid: boolean;
  },
): InstallmentPlan {
  return tx(db, () => {
    const planId = Number(
      db
        .prepare(
          "INSERT INTO installment_plans (name, total_cents, count, every_days, category_id, first_date) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(p.name, p.totalCents, p.count, p.everyDays, p.categoryId, p.firstDate).lastInsertRowid,
    );
    const each = Math.floor(p.totalCents / p.count);
    const insert = db.prepare(
      "INSERT INTO transactions (kind, date, amount_cents, description, category_id, paid, account_id, plan_id, plan_seq) VALUES ('expense', ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < p.count; i++) {
      const amount = i === p.count - 1 ? p.totalCents - each * (p.count - 1) : each;
      const paid = i === 0 && p.firstPaid ? 1 : 0;
      insert.run(installmentDate(p.firstDate, i, p.everyDays), amount, p.name, p.categoryId, paid, p.accountId, planId, i + 1);
    }
    return listInstallmentPlans(db).find((x) => x.id === planId)!;
  });
}

export function listInstallmentPlans(db: DB): InstallmentPlan[] {
  const plans = db.prepare("SELECT * FROM installment_plans ORDER BY id DESC").all() as Row[];
  const txs = (db.prepare(`${TX_SELECT} WHERE t.plan_id IS NOT NULL ORDER BY t.plan_seq`).all() as Row[]).map(
    toTransaction,
  );
  return plans.map((r) => {
    const id = Number(r.id);
    const installments = txs.filter((t) => t.installment!.planId === id);
    const paidCents = installments.filter((t) => t.paid).reduce((a, t) => a + t.amountCents, 0);
    const unpaid = installments.filter((t) => !t.paid);
    return {
      id,
      name: String(r.name),
      totalCents: Number(r.total_cents),
      count: Number(r.count),
      everyDays: r.every_days == null ? null : Number(r.every_days),
      categoryId: r.category_id == null ? null : Number(r.category_id),
      installments,
      paidCents,
      remainingCents: unpaid.reduce((a, t) => a + t.amountCents, 0),
      nextDue: unpaid.length ? unpaid.map((t) => t.date).sort()[0] : null,
    };
  });
}

/** Deletes a purchase with all its installments, paid ones included. */
export function deleteInstallmentPlan(db: DB, id: number): void {
  db.prepare("DELETE FROM installment_plans WHERE id = ?").run(id);
}

// Accounts

export function listAccounts(db: DB): Account[] {
  const rows = db
    .prepare(
      `SELECT a.*, a.opening_cents
         + COALESCE((SELECT SUM(CASE WHEN kind = 'income' THEN amount_cents ELSE -amount_cents END)
                     FROM transactions WHERE ${ACCOUNT_OF} = a.id AND paid = 1), 0)
         + COALESCE((SELECT SUM(amount_cents) FROM transfers WHERE to_account_id = a.id AND scheduled = 0), 0)
         - COALESCE((SELECT SUM(amount_cents) FROM transfers WHERE from_account_id = a.id AND scheduled = 0), 0)
         - COALESCE((SELECT SUM(amount_cents) FROM savings_movements WHERE account_id = a.id AND opening = 0 AND scheduled = 0), 0)
         + COALESCE((SELECT SUM(CASE direction WHEN 'borrowed' THEN amount_cents ELSE -amount_cents END)
                     FROM personal_loans WHERE account_id = a.id AND scheduled = 0), 0)
         + COALESCE((SELECT SUM(CASE l.direction WHEN 'lent' THEN p.amount_cents ELSE -p.amount_cents END)
                     FROM personal_loan_payments p JOIN personal_loans l ON l.id = p.loan_id WHERE p.account_id = a.id AND p.scheduled = 0), 0)
         + COALESCE((SELECT SUM(amount_cents) FROM account_adjustments WHERE account_id = a.id), 0) AS balance
       FROM accounts a ORDER BY a.sort, a.id`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    openingCents: Number(r.opening_cents),
    isDefault: Boolean(r.is_default),
    sort: Number(r.sort),
    archived: Boolean(r.archived),
    balanceCents: Number(r.balance),
  }));
}

export function saveAccount(
  db: DB,
  a: { id?: number; name: string; openingCents: number; isDefault: boolean; sort: number; archived: boolean },
): number {
  return tx(db, () => {
    let id = a.id;
    if (id) {
      db.prepare("UPDATE accounts SET name = ?, opening_cents = ?, sort = ?, archived = ? WHERE id = ?").run(
        a.name,
        a.openingCents,
        a.sort,
        a.archived ? 1 : 0,
        id,
      );
    } else {
      id = Number(
        db
          .prepare("INSERT INTO accounts (name, opening_cents, sort, archived) VALUES (?, ?, ?, ?)")
          .run(a.name, a.openingCents, a.sort, a.archived ? 1 : 0).lastInsertRowid,
      );
    }
    if (a.isDefault) {
      // Entries without an account follow the default, so pin them before it moves.
      const old = db.prepare("SELECT id FROM accounts WHERE is_default = 1").get() as { id: number } | undefined;
      if (old && Number(old.id) !== id)
        db.prepare("UPDATE transactions SET account_id = ? WHERE account_id IS NULL").run(old.id);
      db.prepare("UPDATE accounts SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END").run(id);
      db.prepare("UPDATE accounts SET archived = 0 WHERE id = ?").run(id);
    }
    return id;
  });
}

/**
 * Deletes an account; its entries move to the default account. Refused for the
 * default account and for accounts with transfers, savings movements or personal
 * loans (deleting those would change the other account's, pot's or loan's history).
 */
export function deleteAccount(db: DB, id: number): boolean {
  const row = db.prepare("SELECT is_default FROM accounts WHERE id = ?").get(id) as
    | { is_default: number }
    | undefined;
  if (!row || row.is_default) return false;
  if (db.prepare("SELECT 1 FROM transfers WHERE from_account_id = ? OR to_account_id = ?").get(id, id))
    return false;
  if (db.prepare("SELECT 1 FROM savings_movements WHERE account_id = ?").get(id)) return false;
  if (
    db.prepare(
      "SELECT 1 FROM personal_loans WHERE account_id = ?1 UNION ALL SELECT 1 FROM personal_loan_payments WHERE account_id = ?1",
    ).get(id)
  )
    return false;
  tx(db, () => {
    db.prepare("UPDATE transactions SET account_id = NULL WHERE account_id = ?").run(id);
    db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
  });
  return true;
}

const toTransfer = (r: Row): Transfer => ({
  id: Number(r.id),
  date: String(r.date),
  amountCents: Number(r.amount_cents),
  fromAccountId: Number(r.from_account_id),
  toAccountId: Number(r.to_account_id),
  note: String(r.note),
  budgetMonth: r.budget_month == null ? null : String(r.budget_month),
  scheduled: Boolean(r.scheduled),
});

export function listTransfers(db: DB, opts: { from?: string; to?: string } = {}): Transfer[] {
  const rows = db
    .prepare(
      `SELECT * FROM transfers WHERE date >= ? AND date < ? ORDER BY date DESC, id DESC`,
    )
    .all(opts.from ?? "0000-01-01", opts.to ?? "9999-12-31") as Row[];
  return rows.map(toTransfer);
}

/** Saves a transfer. An edit keeps the budget month it was confirmed for. */
export function saveTransfer(
  db: DB,
  t: Omit<Transfer, "id" | "budgetMonth" | "scheduled"> & { id?: number; budgetMonth?: string | null },
  today = todayISO(),
): number {
  const scheduled = waits(db, "transfers", t.id, t.date, today);
  if (t.id) {
    db.prepare(
      "UPDATE transfers SET date = ?, amount_cents = ?, from_account_id = ?, to_account_id = ?, note = ?, scheduled = ? WHERE id = ?",
    ).run(t.date, t.amountCents, t.fromAccountId, t.toAccountId, t.note, scheduled, t.id);
    return t.id;
  }
  return Number(
    db
      .prepare(
        "INSERT INTO transfers (date, amount_cents, from_account_id, to_account_id, note, budget_month, scheduled) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.date, t.amountCents, t.fromAccountId, t.toAccountId, t.note, t.budgetMonth ?? null, scheduled).lastInsertRowid,
  );
}

export function deleteTransfer(db: DB, id: number): void {
  db.prepare("DELETE FROM transfers WHERE id = ?").run(id);
}

// Savings

export function listPots(db: DB): SavingsPot[] {
  const rows = db
    .prepare(
      `SELECT p.*, COALESCE(SUM(m.amount_cents), 0) AS balance
       FROM savings_pots p LEFT JOIN savings_movements m ON m.pot_id = p.id AND m.scheduled = 0
       GROUP BY p.id ORDER BY p.sort, p.name`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    goalCents: Number(r.goal_cents),
    balanceCents: Number(r.balance),
    sort: Number(r.sort),
  }));
}

export function savePot(db: DB, p: { id?: number; name: string; goalCents: number; sort: number }) {
  if (p.id) {
    db.prepare("UPDATE savings_pots SET name = ?, goal_cents = ?, sort = ? WHERE id = ?").run(
      p.name,
      p.goalCents,
      p.sort,
      p.id,
    );
    return p.id;
  }
  return Number(
    db
      .prepare("INSERT INTO savings_pots (name, goal_cents, sort) VALUES (?, ?, ?)")
      .run(p.name, p.goalCents, p.sort).lastInsertRowid,
  );
}

export function ensurePot(db: DB, name: string): number {
  const found = db
    .prepare("SELECT id FROM savings_pots WHERE lower(name) = lower(?)")
    .get(name) as { id: number } | undefined;
  if (found) return Number(found.id);
  const sort = (
    db.prepare("SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM savings_pots").get() as { s: number }
  ).s;
  return savePot(db, { name, goalCents: 0, sort });
}

export function deletePot(db: DB, id: number): void {
  db.prepare("DELETE FROM savings_pots WHERE id = ?").run(id);
}

export function listMovements(db: DB, potId?: number): SavingsMovement[] {
  const rows = (
    potId
      ? db.prepare("SELECT * FROM savings_movements WHERE pot_id = ? ORDER BY date DESC, id DESC").all(potId)
      : db.prepare("SELECT * FROM savings_movements ORDER BY date DESC, id DESC").all()
  ) as Row[];
  return rows.map((r) => ({
    id: Number(r.id),
    potId: Number(r.pot_id),
    date: String(r.date),
    amountCents: Number(r.amount_cents),
    place: String(r.place),
    note: String(r.note),
    opening: Boolean(r.opening),
    accountId: r.account_id == null ? null : Number(r.account_id),
    scheduled: Boolean(r.scheduled),
  }));
}

export function saveMovement(
  db: DB,
  m: Omit<SavingsMovement, "id" | "accountId" | "scheduled"> & { id?: number; accountId?: number | null },
  today = todayISO(),
): number {
  const accountId = m.accountId ?? null;
  // A starting balance is not money moved, so it never waits.
  const scheduled = m.opening ? 0 : waits(db, "savings_movements", m.id, m.date, today);
  if (m.id) {
    db.prepare(
      "UPDATE savings_movements SET pot_id = ?, date = ?, amount_cents = ?, place = ?, note = ?, opening = ?, account_id = ?, scheduled = ? WHERE id = ?",
    ).run(m.potId, m.date, m.amountCents, m.place, m.note, m.opening ? 1 : 0, accountId, scheduled, m.id);
    return m.id;
  }
  return Number(
    db
      .prepare(
        "INSERT INTO savings_movements (pot_id, date, amount_cents, place, note, opening, account_id, scheduled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(m.potId, m.date, m.amountCents, m.place, m.note, m.opening ? 1 : 0, accountId, scheduled).lastInsertRowid,
  );
}

export function deleteMovement(db: DB, id: number): void {
  db.prepare("DELETE FROM savings_movements WHERE id = ?").run(id);
}

// Plan (fixed costs, subscriptions, investments, donations, annual costs)

export function listPlanItems(db: DB): PlanItem[] {
  return (db.prepare("SELECT * FROM plan_items ORDER BY section, sort, id").all() as Row[]).map(
    (r) => ({
      id: Number(r.id),
      section: r.section as PlanSection,
      name: String(r.name),
      amountCents: Number(r.amount_cents),
      month: r.month == null ? null : Number(r.month),
      sort: Number(r.sort),
      debitDay: r.debit_day == null ? null : Number(r.debit_day),
      categoryId: r.category_id == null ? null : Number(r.category_id),
      accountId: r.account_id == null ? null : Number(r.account_id),
    }),
  );
}

type PlanItemInput = Omit<PlanItem, "id" | "debitDay" | "categoryId" | "accountId"> &
  Partial<Pick<PlanItem, "debitDay" | "categoryId" | "accountId">> & { id?: number };

/** Saves a plan item. Only subscriptions keep a debit day; `today` is when automatic expenses start. */
export function savePlanItem(db: DB, p: PlanItemInput, today = todayISO()): number {
  const debitDay = p.section === "subscription" ? (p.debitDay ?? null) : null;
  const categoryId = p.categoryId ?? null;
  const accountId = p.accountId ?? null;
  if (p.id) {
    const before = db.prepare("SELECT debit_day, charge_from FROM plan_items WHERE id = ?").get(p.id) as
      | { debit_day: number | null; charge_from: string | null }
      | undefined;
    // Keep the start date while a day stays set, so changing the day doesn't charge a month twice.
    const chargeFrom = debitDay == null ? null : before?.debit_day == null ? today : before.charge_from ?? today;
    db.prepare(
      `UPDATE plan_items SET section = ?, name = ?, amount_cents = ?, month = ?, sort = ?,
         debit_day = ?, charge_from = ?, category_id = ?, account_id = ? WHERE id = ?`,
    ).run(p.section, p.name, p.amountCents, p.month, p.sort, debitDay, chargeFrom, categoryId, accountId, p.id);
    return p.id;
  }
  return Number(
    db
      .prepare(
        `INSERT INTO plan_items (section, name, amount_cents, month, sort, debit_day, charge_from, category_id, account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.section, p.name, p.amountCents, p.month, p.sort, debitDay, debitDay == null ? null : today, categoryId, accountId)
      .lastInsertRowid,
  );
}

export function deletePlanItem(db: DB, id: number): void {
  db.prepare("DELETE FROM plan_items WHERE id = ?").run(id);
}

// Loans

export function listLoans(db: DB): Loan[] {
  const loans = db.prepare("SELECT * FROM loans ORDER BY sort, id").all() as Row[];
  const amort = db
    .prepare("SELECT * FROM loan_amortizations ORDER BY year")
    .all() as Row[];
  return loans.map((l) => ({
    id: Number(l.id),
    name: String(l.name),
    principalCents: Number(l.principal_cents),
    monthlyCents: Number(l.monthly_cents),
    paidOff: Boolean(l.paid_off),
    mortgage: Boolean(l.mortgage),
    sort: Number(l.sort),
    accountId: l.account_id == null ? null : Number(l.account_id),
    categoryId: l.category_id == null ? null : Number(l.category_id),
    debitDay: l.debit_day == null ? null : Number(l.debit_day),
    amortizations: amort
      .filter((a) => Number(a.loan_id) === Number(l.id))
      .map((a) => ({ year: Number(a.year), amountCents: Number(a.amount_cents) })),
  }));
}

type LoanInput = Omit<Loan, "id" | "accountId" | "categoryId" | "debitDay"> & {
  id?: number;
  accountId?: number | null;
  categoryId?: number | null;
  debitDay?: number | null;
};

/** Saves a bank loan; leaving `accountId`, `categoryId` or `debitDay` out keeps what it has. */
export function saveLoan(db: DB, l: LoanInput, today = todayISO()): number {
  return tx(db, () => {
    let id = l.id;
    if (id) {
      db.prepare(
        "UPDATE loans SET name = ?, principal_cents = ?, monthly_cents = ?, paid_off = ?, mortgage = ?, sort = ? WHERE id = ?",
      ).run(l.name, l.principalCents, l.monthlyCents, l.paidOff ? 1 : 0, l.mortgage ? 1 : 0, l.sort, id);
      db.prepare("DELETE FROM loan_amortizations WHERE loan_id = ?").run(id);
      if (l.accountId !== undefined) db.prepare("UPDATE loans SET account_id = ? WHERE id = ?").run(l.accountId, id);
      if (l.categoryId !== undefined) db.prepare("UPDATE loans SET category_id = ? WHERE id = ?").run(l.categoryId, id);
      if (l.debitDay !== undefined) setLoanDebitDay(db, id, l.debitDay, today);
    } else {
      id = Number(
        db
          .prepare(
            `INSERT INTO loans (name, principal_cents, monthly_cents, paid_off, mortgage, sort, account_id, category_id, debit_day, charge_from)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            l.name,
            l.principalCents,
            l.monthlyCents,
            l.paidOff ? 1 : 0,
            l.mortgage ? 1 : 0,
            l.sort,
            l.accountId ?? null,
            l.categoryId ?? null,
            l.debitDay ?? null,
            l.debitDay == null ? null : today,
          )
          .lastInsertRowid,
      );
    }
    const ins = db.prepare(
      "INSERT INTO loan_amortizations (loan_id, year, amount_cents) VALUES (?, ?, ?)",
    );
    for (const a of l.amortizations) if (a.amountCents) ins.run(id, a.year, a.amountCents);
    return id;
  });
}

export function setLoanAccount(db: DB, id: number, accountId: number | null): void {
  db.prepare("UPDATE loans SET account_id = ? WHERE id = ?").run(accountId, id);
}

export function setLoanCategory(db: DB, id: number, categoryId: number | null): void {
  db.prepare("UPDATE loans SET category_id = ? WHERE id = ?").run(categoryId, id);
}

/** Sets the day a loan's payment is debited; `today` is when automatic expenses start. */
export function setLoanDebitDay(db: DB, id: number, debitDay: number | null, today = todayISO()): void {
  const before = db.prepare("SELECT debit_day, charge_from FROM loans WHERE id = ?").get(id) as
    | { debit_day: number | null; charge_from: string | null }
    | undefined;
  // Keep the start date while a day stays set, so changing the day doesn't charge a month twice.
  const chargeFrom = debitDay == null ? null : before?.debit_day == null ? today : before.charge_from ?? today;
  db.prepare("UPDATE loans SET debit_day = ?, charge_from = ? WHERE id = ?").run(debitDay, chargeFrom, id);
}

export function deleteLoan(db: DB, id: number): void {
  db.prepare("DELETE FROM loans WHERE id = ?").run(id);
}

// Personal loans (money lent to or borrowed from people)

export function listPersonalLoans(db: DB): PersonalLoan[] {
  const loans = db.prepare("SELECT * FROM personal_loans ORDER BY date DESC, id DESC").all() as Row[];
  const payments = (
    db.prepare("SELECT * FROM personal_loan_payments ORDER BY date DESC, id DESC").all() as Row[]
  ).map(
    (p): PersonalLoanPayment => ({
      id: Number(p.id),
      loanId: Number(p.loan_id),
      date: String(p.date),
      amountCents: Number(p.amount_cents),
      note: String(p.note),
      batch: p.batch == null ? null : String(p.batch),
      accountId: p.account_id == null ? null : Number(p.account_id),
      scheduled: Boolean(p.scheduled),
    }),
  );
  return loans.map((l) => {
    const own = payments.filter((p) => p.loanId === Number(l.id));
    const paid = own.reduce((a, p) => a + p.amountCents, 0);
    return {
      id: Number(l.id),
      person: String(l.person),
      direction: l.direction as PersonalLoanDirection,
      date: String(l.date),
      amountCents: Number(l.amount_cents),
      dueDate: l.due_date == null ? null : String(l.due_date),
      note: String(l.note),
      accountId: l.account_id == null ? null : Number(l.account_id),
      scheduled: Boolean(l.scheduled),
      payments: own,
      paidCents: paid,
      outstandingCents: Number(l.amount_cents) - paid,
    };
  });
}

export function savePersonalLoan(
  db: DB,
  l: Omit<PersonalLoan, "id" | "payments" | "paidCents" | "outstandingCents" | "accountId" | "scheduled"> & { id?: number; accountId?: number | null },
  today = todayISO(),
): number {
  const scheduled = waits(db, "personal_loans", l.id, l.date, today);
  if (l.id) {
    db.prepare(
      "UPDATE personal_loans SET person = ?, direction = ?, date = ?, amount_cents = ?, due_date = ?, note = ?, scheduled = ? WHERE id = ?",
    ).run(l.person, l.direction, l.date, l.amountCents, l.dueDate, l.note, scheduled, l.id);
    return l.id;
  }
  return Number(
    db
      .prepare(
        "INSERT INTO personal_loans (person, direction, date, amount_cents, due_date, note, account_id, scheduled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(l.person, l.direction, l.date, l.amountCents, l.dueDate, l.note, l.accountId ?? null, scheduled).lastInsertRowid,
  );
}

export function deletePersonalLoan(db: DB, id: number): void {
  db.prepare("DELETE FROM personal_loans WHERE id = ?").run(id);
}

export function savePersonalLoanPayment(
  db: DB,
  p: Omit<PersonalLoanPayment, "id" | "batch" | "accountId" | "scheduled"> & { id?: number },
  today = todayISO(),
): number {
  const scheduled = waits(db, "personal_loan_payments", p.id, p.date, today);
  if (p.id) {
    db.prepare(
      "UPDATE personal_loan_payments SET loan_id = ?, date = ?, amount_cents = ?, note = ?, scheduled = ? WHERE id = ?",
    ).run(p.loanId, p.date, p.amountCents, p.note, scheduled, p.id);
    return p.id;
  }
  return Number(
    db
      .prepare(
        "INSERT INTO personal_loan_payments (loan_id, date, amount_cents, note, scheduled) VALUES (?, ?, ?, ?, ?)",
      )
      .run(p.loanId, p.date, p.amountCents, p.note, scheduled).lastInsertRowid,
  );
}

export function deletePersonalLoanPayment(db: DB, id: number): void {
  db.prepare("DELETE FROM personal_loan_payments WHERE id = ?").run(id);
}

/** Same person whatever the spelling: "Inês", " inês " and "INÊS" are one person. */
export const personKey = (person: string) => person.trim().toLocaleLowerCase("pt-PT");

/**
 * Records one repayment to or from a person, paying their oldest open loans in that
 * direction first. Returns null when the amount is more than what is still owed.
 */
export function payPerson(
  db: DB,
  p: { person: string; direction: PersonalLoanDirection; date: string; amountCents: number; note: string; accountId?: number | null },
  today = todayISO(),
): { batch: string; paid: number } | null {
  return tx(db, () => {
    const open = listPersonalLoans(db)
      .filter((l) => personKey(l.person) === personKey(p.person) && l.direction === p.direction && l.outstandingCents > 0)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    if (p.amountCents > open.reduce((a, l) => a + l.outstandingCents, 0)) return null;
    const batch = crypto.randomUUID();
    const ins = db.prepare(
      "INSERT INTO personal_loan_payments (loan_id, date, amount_cents, note, batch, account_id, scheduled) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    let left = p.amountCents;
    let paid = 0;
    for (const l of open) {
      if (left === 0) break;
      const part = Math.min(left, l.outstandingCents);
      ins.run(l.id, p.date, part, p.note, batch, p.accountId ?? null, p.date > today ? 1 : 0);
      left -= part;
      paid++;
    }
    return { batch, paid };
  });
}

/** Personal loans given or taken, and repayments, dated in [from, to); a split repayment is one move. */
export function listLoanMoves(db: DB, from: string, to: string): LoanMove[] {
  const moves: LoanMove[] = [];
  const batches = new Map<string, LoanMove>();
  for (const l of listPersonalLoans(db)) {
    if (l.date >= from && l.date < to)
      moves.push({
        key: `l${l.id}`,
        date: l.date,
        person: l.person.trim(),
        repay: false,
        amountCents: l.direction === "borrowed" ? l.amountCents : -l.amountCents,
        accountId: l.accountId,
        note: l.note,
        scheduled: l.scheduled,
      });
    for (const p of l.payments) {
      if (p.date < from || p.date >= to) continue;
      const cents = l.direction === "lent" ? p.amountCents : -p.amountCents;
      const same = p.batch ? batches.get(p.batch) : undefined;
      if (same) {
        same.amountCents += cents;
        continue;
      }
      const move = { key: `p${p.batch ?? p.id}`, date: p.date, person: l.person.trim(), repay: true, amountCents: cents, accountId: p.accountId, note: p.note, scheduled: p.scheduled };
      if (p.batch) batches.set(p.batch, move);
      moves.push(move);
    }
  }
  return moves.sort((a, b) => b.date.localeCompare(a.date));
}

export function deletePaymentBatch(db: DB, batch: string): void {
  db.prepare("DELETE FROM personal_loan_payments WHERE batch = ?").run(batch);
}

// Baby Steps settings (the steps themselves are computed in baby-steps.ts)

const optionalId = (v: string) => (v ? Number(v) : null);

export function getBabyStepSettings(db: DB): BabyStepSettings {
  return {
    emergencyPotId: optionalId(getSetting(db, "baby_emergency_pot_id", "")),
    starterFundCents: Number(getSetting(db, "baby_starter_fund_cents", "100000")),
    emergencyMonths: Number(getSetting(db, "baby_emergency_months", "6")),
    investPercent: Number(getSetting(db, "baby_invest_percent", "15")),
    educationPotId: optionalId(getSetting(db, "baby_education_pot_id", "")),
  };
}

export function updateBabyStepSettings(db: DB, s: Partial<BabyStepSettings>): BabyStepSettings {
  if (s.emergencyPotId !== undefined)
    setSetting(db, "baby_emergency_pot_id", s.emergencyPotId == null ? "" : String(s.emergencyPotId));
  if (s.starterFundCents !== undefined) setSetting(db, "baby_starter_fund_cents", String(s.starterFundCents));
  if (s.emergencyMonths !== undefined) setSetting(db, "baby_emergency_months", String(s.emergencyMonths));
  if (s.investPercent !== undefined) setSetting(db, "baby_invest_percent", String(s.investPercent));
  if (s.educationPotId !== undefined)
    setSetting(db, "baby_education_pot_id", s.educationPotId == null ? "" : String(s.educationPotId));
  return getBabyStepSettings(db);
}

/** Deletes every financial record. Settings and the login stay; a fresh main account is created. */
export function wipeData(db: DB): void {
  tx(db, () => {
    db.exec(`
      DELETE FROM account_adjustments; DELETE FROM month_closes;
      DELETE FROM plan_charges; DELETE FROM loan_charges; DELETE FROM transactions; DELETE FROM installment_plans;
      DELETE FROM transfers; DELETE FROM savings_movements; DELETE FROM savings_pots;
      DELETE FROM plan_items; DELETE FROM loan_amortizations; DELETE FROM loans;
      DELETE FROM personal_loan_payments; DELETE FROM personal_loans;
      DELETE FROM savings_month_plans; DELETE FROM category_month_plans;
      DELETE FROM investment_trades; DELETE FROM investments;
      DELETE FROM categories; DELETE FROM accounts;
      INSERT INTO accounts (name, is_default) VALUES ('Conta principal', 1);
    `);
  });
}

// Closed months

export function getClose(db: DB, month: string): MonthClose | null {
  const r = db.prepare("SELECT * FROM month_closes WHERE month = ?").get(month) as Row | undefined;
  if (!r) return null;
  const adjustments = (
    db.prepare("SELECT * FROM account_adjustments WHERE close_month = ? ORDER BY id").all(month) as Row[]
  ).map((a) => ({ id: Number(a.id), accountId: Number(a.account_id), date: String(a.date), amountCents: Number(a.amount_cents) }));
  return { month, closedAt: String(r.closed_at), balanceCents: Number(r.balance_cents), adjustments };
}

/** Whether a date ("YYYY-MM-DD") falls in a closed budget month. */
export function isClosedDate(db: DB, date: string): boolean {
  const month = monthOf(date, monthStartOf(getSettings(db)));
  return db.prepare("SELECT 1 FROM month_closes WHERE month = ?").get(month) != null;
}
