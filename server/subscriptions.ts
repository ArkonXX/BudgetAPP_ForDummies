// Subscriptions with a debit day become a paid expense on that day of each
// month, like the bank's direct debit. Each item is added at most once per
// calendar month (plan_charges), so deleting the expense doesn't bring it
// back, and an expense with the same name already in that month counts as
// the debit instead of adding a second one.
import type { DB } from "./db.ts";
import { tx } from "./db.ts";
import { ensureCategory, listPlanItems } from "./store.ts";
import { addMonths } from "../shared/period.ts";
import type { PlanItem, UpcomingDebit } from "../shared/types.ts";

const CATEGORY = "Subscrições";

const daysInMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/** The date an item is debited in a calendar month ("YYYY-MM"). */
export function debitDate(day: number, month: string): string {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, "0")}`;
}

type Debit = { item: PlanItem; month: string; date: string; chargeFrom: string };

/** Debit dates in [from, to) of the subscriptions that have a debit day. */
function debitsBetween(db: DB, from: string, to: string): Debit[] {
  const starts = new Map(
    (db.prepare("SELECT id, charge_from FROM plan_items WHERE debit_day IS NOT NULL").all() as {
      id: number;
      charge_from: string | null;
    }[]).map((r) => [Number(r.id), r.charge_from ?? ""]),
  );
  const out: Debit[] = [];
  for (const item of listPlanItems(db)) {
    if (item.section !== "subscription" || item.debitDay == null) continue;
    const chargeFrom = starts.get(item.id) ?? "";
    for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addMonths(m, 1)) {
      const date = debitDate(item.debitDay, m);
      if (date >= from && date < to && date >= chargeFrom) out.push({ item, month: m, date, chargeFrom });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.item.sort - b.item.sort);
}

/** Whether the debit is already in: added before, or an expense with its name that month. */
function isCovered(db: DB, d: Debit): boolean {
  if (db.prepare("SELECT 1 FROM plan_charges WHERE item_id = ? AND month = ?").get(d.item.id, d.month)) return true;
  return matchingExpense(db, d) != null;
}

function matchingExpense(db: DB, d: Debit): number | null {
  const row = db
    .prepare(
      `SELECT id FROM transactions WHERE kind = 'expense' AND lower(trim(description)) = lower(?)
       AND date >= ? AND date < ? ORDER BY id LIMIT 1`,
    )
    .get(d.item.name.trim(), `${d.month}-01`, `${addMonths(d.month, 1)}-01`) as { id: number } | undefined;
  return row ? Number(row.id) : null;
}

/** Adds the expenses of every debit due by `today` that isn't in yet. Returns how many were added. */
export function chargeSubscriptions(db: DB, today: string): number {
  const first = (
    db.prepare("SELECT MIN(charge_from) AS d FROM plan_items WHERE debit_day IS NOT NULL").get() as {
      d: string | null;
    }
  ).d;
  if (!first || first > today) return 0;
  const due = debitsBetween(db, first, nextDay(today)).filter(
    (d) => !db.prepare("SELECT 1 FROM plan_charges WHERE item_id = ? AND month = ?").get(d.item.id, d.month),
  );
  if (!due.length) return 0;
  let added = 0;
  tx(db, () => {
    for (const d of due) {
      let txId = matchingExpense(db, d);
      if (txId == null) {
        const categoryId = d.item.categoryId ?? ensureCategory(db, "expense", CATEGORY);
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
      db.prepare("INSERT INTO plan_charges (item_id, month, transaction_id) VALUES (?, ?, ?)").run(
        d.item.id,
        d.month,
        txId,
      );
    }
  });
  return added;
}

/** Subscription debits in [from, to) after `today` that aren't in yet. */
export function upcomingDebits(db: DB, from: string, to: string, today: string): UpcomingDebit[] {
  const start = nextDay(today) > from ? nextDay(today) : from;
  if (start >= to) return [];
  const debits = debitsBetween(db, start, to).filter((d) => !isCovered(db, d));
  if (!debits.length) return [];
  const defaultAccount = db.prepare("SELECT id FROM accounts WHERE is_default = 1").get() as { id: number } | undefined;
  const subs = db
    .prepare("SELECT id FROM categories WHERE kind = 'expense' AND lower(name) = lower(?)")
    .get(CATEGORY) as { id: number } | undefined;
  return debits.map((d) => ({
    itemId: d.item.id,
    name: d.item.name,
    date: d.date,
    amountCents: d.item.amountCents,
    categoryId: d.item.categoryId ?? (subs ? Number(subs.id) : null),
    accountId: d.item.accountId ?? Number(defaultAccount?.id ?? 0),
  }));
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
}
