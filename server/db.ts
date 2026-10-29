import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { installmentDate, todayISO } from "../shared/period.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  name TEXT NOT NULL,
  planned_cents INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, name)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  paid INTEGER NOT NULL DEFAULT 1, -- 0 = expense still to pay, dated when it was due
  plan_id INTEGER REFERENCES installment_plans(id) ON DELETE CASCADE, -- one installment of a purchase
  plan_seq INTEGER -- which installment, from 1
);
CREATE INDEX IF NOT EXISTS transactions_date ON transactions(date);

-- A purchase paid in installments (e.g. Klarna): each installment is an
-- expense in transactions, unpaid until it is paid.
CREATE TABLE IF NOT EXISTS installment_plans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  count INTEGER NOT NULL,
  every_days INTEGER, -- NULL = same day every month
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  first_date TEXT -- due date of the first installment
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  opening_cents INTEGER NOT NULL DEFAULT 0, -- balance before the first entry in the app
  is_default INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

-- Money moved between two of my own accounts: changes balances, not the budget.
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS transfers_date ON transfers(date);

CREATE TABLE IF NOT EXISTS savings_pots (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  goal_cents INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS savings_movements (
  id INTEGER PRIMARY KEY,
  pot_id INTEGER NOT NULL REFERENCES savings_pots(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  opening INTEGER NOT NULL DEFAULT 0 -- starting balance carried over, not a deposit
);
CREATE INDEX IF NOT EXISTS savings_movements_date ON savings_movements(date);

CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY,
  section TEXT NOT NULL CHECK (section IN ('fixed', 'subscription', 'investment', 'donation', 'annual')),
  name TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  month INTEGER,
  sort INTEGER NOT NULL DEFAULT 0
);

-- Subscriptions already added as an expense, one per item and calendar month,
-- so a deleted expense is not added again.
CREATE TABLE IF NOT EXISTS plan_charges (
  item_id INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  month TEXT NOT NULL, -- calendar month "YYYY-MM"
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  PRIMARY KEY (item_id, month)
);

-- Planned amount for one budget month, overriding the category's usual
-- planned amount (or, for savings, the planned savings setting).
CREATE TABLE IF NOT EXISTS category_month_plans (
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT NOT NULL, -- budget month "YYYY-MM"
  planned_cents INTEGER NOT NULL,
  PRIMARY KEY (category_id, month)
);
CREATE TABLE IF NOT EXISTS savings_month_plans (
  month TEXT PRIMARY KEY, -- budget month "YYYY-MM"
  planned_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  principal_cents INTEGER NOT NULL DEFAULT 0,
  monthly_cents INTEGER NOT NULL DEFAULT 0,
  paid_off INTEGER NOT NULL DEFAULT 0,
  mortgage INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

-- Bank loan payments already added as an expense, one per loan and calendar
-- month, so a deleted expense is not added again.
CREATE TABLE IF NOT EXISTS loan_charges (
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  month TEXT NOT NULL, -- calendar month "YYYY-MM"
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  PRIMARY KEY (loan_id, month)
);

CREATE TABLE IF NOT EXISTS loan_amortizations (
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  PRIMARY KEY (loan_id, year)
);

CREATE TABLE IF NOT EXISTS personal_loans (
  id INTEGER PRIMARY KEY,
  person TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('lent', 'borrowed')),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  due_date TEXT,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS personal_loan_payments (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES personal_loans(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

-- A budget month that has been closed: entries dated in it can no longer
-- change. action, pot_*, movement_id and carry_cents are only set on months
-- closed by an earlier version, which also moved the leftover; they are ignored.
CREATE TABLE IF NOT EXISTS month_closes (
  month TEXT PRIMARY KEY, -- budget month "YYYY-MM"
  closed_at TEXT NOT NULL,
  balance_cents INTEGER NOT NULL, -- the month's balance when closed, before anything was moved
  action TEXT NOT NULL CHECK (action IN ('carry', 'pot', 'none')),
  pot_id INTEGER REFERENCES savings_pots(id) ON DELETE SET NULL,
  pot_cents INTEGER NOT NULL DEFAULT 0, -- put in (leftover) or taken out of (shortfall) the pot
  movement_id INTEGER REFERENCES savings_movements(id) ON DELETE SET NULL,
  carry_cents INTEGER NOT NULL DEFAULT 0 -- added to (or taken from) the next month's balance
);

-- A correction so an account's balance matches the bank, made when closing a
-- month; changes balances, not the budget.
CREATE TABLE IF NOT EXISTS account_adjustments (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  close_month TEXT REFERENCES month_closes(month) ON DELETE CASCADE -- the close it was made with; cleared on reopen
);

-- Stocks, ETFs, crypto… (the spreadsheet's Investimentos sheet). Prices in EUR per unit.
CREATE TABLE IF NOT EXISTS investments (
  id INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'stock' CHECK (kind IN ('stock', 'etf', 'crypto', 'fund', 'other')),
  quote REAL,
  quote_date TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

-- Buys and sells (the Transacoes sheet). total_cents is what was paid or received in EUR, fees included.
CREATE TABLE IF NOT EXISTS investment_trades (
  id INTEGER PRIMARY KEY,
  investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity REAL NOT NULL CHECK (quantity > 0),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** A first guess at an expense category's group, from its (Portuguese or English) name. */
export function guessExpenseGroup(name: string): "credit" | "fixed" | "variable" {
  const n = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/credito|financ|finac|amortiz|armortiz|emprestimo|prestac|hipotec|leasing|loan|credit|mortgage/.test(n)) return "credit";
  if (/subscri|comunica|bancari|mensa|seguro|renda|condomin|eletric|electric|agua|\bgas\b|\bluz\b|internet|telem|ajudas casa|propina|rent|insurance|utilit/.test(n))
    return "fixed";
  return "variable";
}

const plainName = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

/**
 * A first guess at the expense category each Plan line and bank loan counts
 * in on the Budget, for those without one: a category with the same name, or
 * else the one the spreadsheet's Sumário used for that kind of line
 * (Subscrições, Investimentos, Doações, Créditos).
 */
export function tiePlanLines(db: DB): void {
  const cats = (db.prepare("SELECT id, name, expense_group FROM categories WHERE kind = 'expense' AND archived = 0 ORDER BY sort, id").all() as {
    id: number;
    name: string;
    expense_group: string;
  }[]).map((c) => ({ id: Number(c.id), name: plainName(c.name), group: c.expense_group }));
  const byName = (name: string) => cats.find((c) => c.name === plainName(name))?.id;
  const byPattern = (re: RegExp, group?: string) => cats.find((c) => re.test(c.name) && (!group || c.group === group))?.id;
  const SECTION: Record<string, RegExp> = { subscription: /subscri/, investment: /invest/, donation: /doac|donativ|donation/ };
  const items = db.prepare("SELECT id, section, name FROM plan_items WHERE category_id IS NULL").all() as { id: number; section: string; name: string }[];
  const setItem = db.prepare("UPDATE plan_items SET category_id = ? WHERE id = ?");
  for (const i of items) {
    const id = byName(i.name) ?? (SECTION[i.section] ? byPattern(SECTION[i.section]) : undefined);
    if (id != null) setItem.run(id, i.id);
  }
  const loans = db.prepare("SELECT id, name FROM loans WHERE category_id IS NULL").all() as { id: number; name: string }[];
  const setLoan = db.prepare("UPDATE loans SET category_id = ? WHERE id = ?");
  for (const l of loans) {
    const id = byName(l.name) ?? byPattern(/credito|financ|finac|emprestimo|loan/, "credit");
    if (id != null) setLoan.run(id, l.id);
  }
}

// Columns added after the first release; CREATE TABLE IF NOT EXISTS skips existing tables.
function migrate(db: DB) {
  const cols = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols("loans").includes("paid_off"))
    db.exec("ALTER TABLE loans ADD COLUMN paid_off INTEGER NOT NULL DEFAULT 0");
  if (!cols("transactions").includes("paid"))
    db.exec("ALTER TABLE transactions ADD COLUMN paid INTEGER NOT NULL DEFAULT 1");
  if (!cols("loans").includes("mortgage"))
    db.exec("ALTER TABLE loans ADD COLUMN mortgage INTEGER NOT NULL DEFAULT 0");
  if (!cols("transactions").includes("plan_id")) {
    db.exec("ALTER TABLE transactions ADD COLUMN plan_id INTEGER REFERENCES installment_plans(id) ON DELETE CASCADE");
    db.exec("ALTER TABLE transactions ADD COLUMN plan_seq INTEGER");
  }
  // Baby Steps used to be ticked by hand; they are now worked out from the data.
  db.exec("DROP TABLE IF EXISTS baby_steps");
  // NULL account_id means the default account (e.g. entries imported from the Excel).
  if (!cols("transactions").includes("account_id"))
    db.exec("ALTER TABLE transactions ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL");
  // NULL here means the deposit didn't come from a tracked account (e.g. imported history).
  if (!cols("savings_movements").includes("account_id"))
    db.exec("ALTER TABLE savings_movements ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL");
  // Subscriptions: the day of the month they are debited, added as an expense on that day.
  if (!cols("plan_items").includes("debit_day")) {
    db.exec("ALTER TABLE plan_items ADD COLUMN debit_day INTEGER");
    // First day the automatic expenses start from, so setting a day doesn't backfill old months.
    db.exec("ALTER TABLE plan_items ADD COLUMN charge_from TEXT");
    db.exec("ALTER TABLE plan_items ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL");
    db.exec("ALTER TABLE plan_items ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL");
  }
  // One repayment to a person can pay off several of their loans; the parts share a batch id.
  if (!cols("personal_loan_payments").includes("batch"))
    db.exec("ALTER TABLE personal_loan_payments ADD COLUMN batch TEXT");
  // Loans and repayments imported from a bank statement move that account's balance; NULL = no account.
  if (!cols("personal_loans").includes("account_id")) {
    db.exec("ALTER TABLE personal_loans ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL");
    db.exec("ALTER TABLE personal_loan_payments ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL");
  }
  if (!cols("installment_plans").includes("first_date"))
    db.exec("ALTER TABLE installment_plans ADD COLUMN first_date TEXT");
  // The account a bank loan's monthly payment leaves from; NULL = the default account.
  if (!cols("loans").includes("account_id"))
    db.exec("ALTER TABLE loans ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL");
  // A transfer confirmed from the monthly suggestion: the budget month it pays for, at most one per account.
  if (!cols("transfers").includes("budget_month")) {
    db.exec("ALTER TABLE transfers ADD COLUMN budget_month TEXT");
    db.exec("CREATE UNIQUE INDEX transfers_budget_month ON transfers(budget_month, to_account_id) WHERE budget_month IS NOT NULL");
  }
  // Which table an expense category shows in. Existing ones are guessed from the name.
  if (!cols("categories").includes("expense_group")) {
    db.exec("ALTER TABLE categories ADD COLUMN expense_group TEXT NOT NULL DEFAULT 'variable'");
    const rows = db.prepare("SELECT id, name FROM categories WHERE kind = 'expense'").all() as { id: number; name: string }[];
    const update = db.prepare("UPDATE categories SET expense_group = ? WHERE id = ?");
    for (const r of rows) update.run(guessExpenseGroup(r.name), r.id);
    db.exec(
      "UPDATE categories SET expense_group = 'fixed' WHERE expense_group = 'variable' AND id IN (SELECT category_id FROM plan_items WHERE section = 'subscription')",
    );
  }
  // The account a day-to-day category's money goes to on payday; NULL = it stays in the salary account.
  if (!cols("categories").includes("account_id"))
    db.exec("ALTER TABLE categories ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL");
  // The expense category a bank loan's monthly payment counts in on the Budget; NULL = its own line.
  if (!cols("loans").includes("category_id")) {
    db.exec("ALTER TABLE loans ADD COLUMN category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL");
    tiePlanLines(db);
  }
  // Bank loans: the day of the month the payment is debited, added as an expense on that day.
  if (!cols("loans").includes("debit_day")) {
    db.exec("ALTER TABLE loans ADD COLUMN debit_day INTEGER");
    db.exec("ALTER TABLE loans ADD COLUMN charge_from TEXT");
  }
  // An entry dated after today doesn't count until that day comes and it is
  // confirmed as debited (or received); until then it is kept unpaid.
  if (!cols("transactions").includes("scheduled")) {
    db.exec("ALTER TABLE transactions ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0");
    db.prepare("UPDATE transactions SET scheduled = 1, paid = 0 WHERE paid = 1 AND plan_id IS NULL AND date > ?").run(todayISO());
  }
  // The same for transfers, savings movements and money lent, borrowed or paid back to people.
  for (const table of ["transfers", "savings_movements", "personal_loans", "personal_loan_payments"])
    if (!cols(table).includes("scheduled")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN scheduled INTEGER NOT NULL DEFAULT 0`);
      const opening = table === "savings_movements" ? " AND opening = 0" : "";
      db.prepare(`UPDATE ${table} SET scheduled = 1 WHERE date > ?${opening}`).run(todayISO());
    }
  restoreInstallments(db);
  const hasDefault = db.prepare("SELECT 1 FROM accounts WHERE is_default = 1").get();
  if (!hasDefault) {
    const first = db.prepare("SELECT id FROM accounts ORDER BY sort, id LIMIT 1").get() as { id: number } | undefined;
    if (first) db.prepare("UPDATE accounts SET is_default = 1 WHERE id = ?").run(first.id);
    else db.exec("INSERT INTO accounts (name, is_default) VALUES ('Conta principal', 1)");
  }
}

/**
 * Deleting one installment from Entries used to remove it from its purchase,
 * so the app thought less was owed. Installments can no longer be deleted on
 * their own; this puts back the ones that went missing, as still to pay.
 */
function restoreInstallments(db: DB) {
  type Plan = { id: number; name: string; total_cents: number; count: number; every_days: number | null; category_id: number | null; first_date: string | null };
  type Inst = { plan_seq: number; date: string; paid: number; account_id: number | null };
  const plans = db.prepare("SELECT * FROM installment_plans").all() as Plan[];
  for (const p of plans) {
    const rows = db
      .prepare("SELECT plan_seq, date, paid, account_id FROM transactions WHERE plan_id = ? ORDER BY plan_seq")
      .all(p.id) as Inst[];
    let first = p.first_date;
    if (!first && rows.length) {
      // Paid installments are dated when they were paid, so an unpaid one gives the best due date.
      const ref = rows.find((r) => !r.paid) ?? rows[0];
      first = installmentDate(ref.date, -(ref.plan_seq - 1), p.every_days);
      db.prepare("UPDATE installment_plans SET first_date = ? WHERE id = ?").run(first, p.id);
    }
    if (!first || rows.length >= p.count) continue;
    const have = new Set(rows.map((r) => r.plan_seq));
    const each = Math.floor(p.total_cents / p.count);
    const insert = db.prepare(
      "INSERT INTO transactions (kind, date, amount_cents, description, category_id, paid, account_id, plan_id, plan_seq) VALUES ('expense', ?, ?, ?, ?, 0, ?, ?, ?)",
    );
    for (let seq = 1; seq <= p.count; seq++) {
      if (have.has(seq)) continue;
      const amount = seq === p.count ? p.total_cents - each * (p.count - 1) : each;
      insert.run(installmentDate(first, seq - 1, p.every_days), amount, p.name, p.category_id, rows[0]?.account_id ?? null, p.id, seq);
    }
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function getSetting(db: DB, key: string, fallback: string): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? fallback;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
