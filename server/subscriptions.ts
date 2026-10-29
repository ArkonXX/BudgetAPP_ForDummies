// Subscriptions and bank loans with a debit day become a paid expense on that
// day of each month, like the bank's direct debit. Each one is added at most
// once per calendar month (plan_charges, loan_charges), so deleting the
// expense doesn't bring it back. An expense already in that counts as the
// debit instead of adding a second one: one with the same name that month, or
// one from the same account for the same amount a few days either side (the
// bank's line, typed in or imported from a statement).
import type { DB } from "./db.ts";
import { tx } from "./db.ts";
import { ensureCategory, listLoans, listPlanItems } from "./store.ts";
import { addMonths } from "../shared/period.ts";
import type { UpcomingDebit } from "../shared/types.ts";

const SUBSCRIPTIONS = "Subscrições";
const LOANS = "Créditos";
// How far from the debit day the bank's own line can be dated.
const NEAR_DAYS = 5;

const daysInMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** The date an item is debited in a calendar month ("YYYY-MM"). */
export function debitDate(day: number, month: string): string {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
}

/** Something debited each month: a subscription on the Plan or a bank loan. */
type Source = {
  source: "plan" | "loan";
  id: number;
  name: string;
  amountCents: number;
  categoryId: number | null;
  accountId: number | null;
  debitDay: number;
  chargeFrom: string;
  sort: number;
};

type Debit = { item: Source; month: string; date: string };

const CHARGES = {
  plan: { table: "plan_charges", key: "item_id" },
  loan: { table: "loan_charges", key: "loan_id" },
} as const;

function sources(db: DB): Source[] {
  const starts = (table: string) =>
    new Map(
      (db.prepare(`SELECT id, charge_from FROM ${table} WHERE debit_day IS NOT NULL`).all() as {
        id: number;
        charge_from: string | null;
      }[]).map((r) => [Number(r.id), r.charge_from ?? ""]),
    );
  const planStarts = starts("plan_items");
  const loanStarts = starts("loans");
  const out: Source[] = [];
  for (const i of listPlanItems(db))
    if (i.section === "subscription" && i.debitDay != null)
      out.push({ source: "plan", id: i.id, name: i.name, amountCents: i.amountCents, categoryId: i.categoryId, accountId: i.accountId, debitDay: i.debitDay, chargeFrom: planStarts.get(i.id) ?? "", sort: i.sort });
  // A paid-off loan is no longer debited.
  for (const l of listLoans(db))
    if (l.debitDay != null && !l.paidOff && l.monthlyCents > 0)
      out.push({ source: "loan", id: l.id, name: l.name, amountCents: l.monthlyCents, categoryId: l.categoryId, accountId: l.accountId, debitDay: l.debitDay, chargeFrom: loanStarts.get(l.id) ?? "", sort: 1000 + l.sort });
  return out;
}

/** Debit dates in [from, to) of the subscriptions and loans that have a debit day. */
function debitsBetween(db: DB, from: string, to: string): Debit[] {
  const out: Debit[] = [];
  for (const item of sources(db)) {
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addMonths(m, 1)) {
      const date = debitDate(item.debitDay, m);
      if (date >= from && date < to && date >= item.chargeFrom) out.push({ item, month: m, date });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.item.sort - b.item.sort);
}

function isCharged(db: DB, d: Debit): boolean {
  const { table, key } = CHARGES[d.item.source];
  return db.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ? AND month = ?`).get(d.item.id, d.month) != null;
}

/** Whether the debit is already in: added before, or an expense that is the same debit. */
function isCovered(db: DB, d: Debit): boolean {
  return isCharged(db, d) || matchingExpense(db, d) != null;
}

function matchingExpense(db: DB, d: Debit): number | null {
  const byName = db
    .prepare(
      `SELECT id FROM transactions WHERE kind = 'expense' AND lower(trim(description)) = lower(?)
       AND date >= ? AND date < ? ORDER BY id LIMIT 1`,
    )
    .get(d.item.name.trim(), `${d.month}-01`, `${addMonths(d.month, 1)}-01`) as { id: number } | undefined;
  if (byName) return Number(byName.id);
  // The same amount from the same account around the debit day, not already another debit.
  const DEFAULT = "(SELECT id FROM accounts WHERE is_default = 1)";
  const near = db
    .prepare(
      `SELECT id FROM transactions t WHERE kind = 'expense' AND amount_cents = ? AND plan_id IS NULL
       AND COALESCE(account_id, ${DEFAULT}) = COALESCE(?, ${DEFAULT})
       AND date >= ? AND date <= ?
       AND NOT EXISTS (SELECT 1 FROM plan_charges c WHERE c.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM loan_charges c WHERE c.transaction_id = t.id)
       ORDER BY abs(julianday(date) - julianday(?)), id LIMIT 1`,
    )
    .get(d.item.amountCents, d.item.accountId, shiftDays(d.date, -NEAR_DAYS), shiftDays(d.date, NEAR_DAYS), d.date) as
    | { id: number }
    | undefined;
  return near ? Number(near.id) : null;
}

/** The category a loan without one is paid in: the first credit category, else "Créditos". */
function loanCategory(db: DB, create: boolean): number | null {
  const credit = db
    .prepare("SELECT id FROM categories WHERE kind = 'expense' AND expense_group = 'credit' AND archived = 0 ORDER BY sort, id LIMIT 1")
    .get() as { id: number } | undefined;
  if (credit) return Number(credit.id);
  if (create) return ensureCategory(db, "expense", LOANS);
  const named = db.prepare("SELECT id FROM categories WHERE kind = 'expense' AND lower(name) = lower(?)").get(LOANS) as
    | { id: number }
    | undefined;
  return named ? Number(named.id) : null;
}

function subscriptionCategory(db: DB): number | null {
  const row = db
    .prepare("SELECT id FROM categories WHERE kind = 'expense' AND lower(name) = lower(?)")
    .get(SUBSCRIPTIONS) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

/** Adds the expenses of every debit due by `today` that isn't in yet. Returns how many were added. */
export function chargeDebits(db: DB, today: string): number {
  const first = (
    db
      .prepare(
        `SELECT MIN(d) AS d FROM (SELECT charge_from AS d FROM plan_items WHERE debit_day IS NOT NULL
         UNION ALL SELECT charge_from FROM loans WHERE debit_day IS NOT NULL)`,
      )
      .get() as { d: string | null }
  ).d;
  if (!first || first > today) return 0;
  const due = debitsBetween(db, first, nextDay(today)).filter((d) => !isCharged(db, d));
  if (!due.length) return 0;
  let added = 0;
  tx(db, () => {
    for (const d of due) {
      let txId = matchingExpense(db, d);
      if (txId == null) {
        let categoryId = d.item.categoryId;
        if (categoryId == null && d.item.source === "plan") categoryId = ensureCategory(db, "expense", SUBSCRIPTIONS);
        if (categoryId == null && d.item.source === "loan") {
          // Tie the loan to the category it is paid in, so the Budget doesn't show it twice.
          categoryId = loanCategory(db, true);
          db.prepare("UPDATE loans SET category_id = ? WHERE id = ? AND category_id IS NULL").run(categoryId, d.item.id);
          d.item.categoryId = categoryId;
        }
        txId = Number(
          db
            .prepare(
              `INSERT INTO transactions (kind, date, amount_cents, description, category_id, paid, account_id)
               VALUES ('expense', ?, ?, ?, ?, 1, ?)`,
            )
            .run(d.date, d.item.amountCents, d.item.name, categoryId, d.item.accountId).lastInsertRowid,
        );
        added++;
      }
      const { table, key } = CHARGES[d.item.source];
      db.prepare(`INSERT INTO ${table} (${key}, month, transaction_id) VALUES (?, ?, ?)`).run(d.item.id, d.month, txId);
    }
  });
  return added;
}

/** Subscription and loan debits in [from, to) after `today` that aren't in yet. */
export function upcomingDebits(db: DB, from: string, to: string, today: string): UpcomingDebit[] {
  const start = nextDay(today) > from ? nextDay(today) : from;
  if (start >= to) return [];
  const debits = debitsBetween(db, start, to).filter((d) => !isCovered(db, d));
  if (!debits.length) return [];
  const defaultAccount = db.prepare("SELECT id FROM accounts WHERE is_default = 1").get() as { id: number } | undefined;
  const subs = subscriptionCategory(db);
  const credit = loanCategory(db, false);
  return debits.map((d) => ({
    source: d.item.source,
    itemId: d.item.id,
    name: d.item.name,
    date: d.date,
    amountCents: d.item.amountCents,
    categoryId: d.item.categoryId ?? (d.item.source === "plan" ? subs : credit),
    accountId: d.item.accountId ?? Number(defaultAccount?.id ?? 0),
  }));
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
}

function nextDay(date: string): string {
  return shiftDays(date, 1);
}
