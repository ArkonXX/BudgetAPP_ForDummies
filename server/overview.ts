import type { DB } from "./db.ts";
import { getSettings, listAccounts, listInstallmentPlans, listPersonalLoans, listPlanItems, listPots, personKey } from "./store.ts";
import { monthSummary, repaidToPeople } from "./reports.ts";
import { addMonths, monthStartOf, parseMonth, periodRange, type Month } from "../shared/period.ts";
import type { Account, Available, Debts, MonthSummary, NetWorth, Overview, Tip, Todo } from "../shared/types.ts";

const DAY = 86400_000;
const dayIndex = (from: string, date: string) =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

// How many earlier months make up the "usual" spending.
const USUAL_MONTHS = 6;
// Debits this close are listed as coming soon.
const SOON_DAYS = 7;

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

type Spend = { categoryId: number | null; day: number; cents: number };

/** Expenses of a budget month, by category and day of the month (0-based). */
function expensesByDay(db: DB, from: string, to: string): Spend[] {
  const rows = db
    .prepare(
      `SELECT category_id, date, SUM(amount_cents) AS total FROM transactions
       WHERE kind = 'expense' AND paid = 1 AND date >= ? AND date < ? GROUP BY category_id, date`,
    )
    .all(from, to) as { category_id: number | null; date: string; total: number }[];
  return rows.map((r) => ({
    categoryId: r.category_id == null ? null : Number(r.category_id),
    day: dayIndex(from, r.date),
    cents: Number(r.total),
  }));
}

function cumulative(spend: Spend[], days: number): number[] {
  const perDay = new Array<number>(days).fill(0);
  for (const s of spend) if (s.day < days) perDay[s.day] += s.cents;
  let run = 0;
  return perDay.map((c) => (run += c));
}

function totals(db: DB, from: string, to: string) {
  const row = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE kind = 'income' AND paid = 1 AND date >= ?1 AND date < ?2), 0) AS income,
         COALESCE((SELECT SUM(amount_cents) FROM transactions WHERE kind = 'expense' AND paid = 1 AND date >= ?1 AND date < ?2), 0) AS expense,
         COALESCE((SELECT SUM(amount_cents) FROM savings_movements WHERE amount_cents > 0 AND opening = 0 AND scheduled = 0 AND date >= ?1 AND date < ?2), 0) AS savings`,
    )
    .get(from, to) as { income: number; expense: number; savings: number };
  return { incomeCents: Number(row.income), expenseCents: Number(row.expense), savingsCents: Number(row.savings) };
}

/** Open personal loans netted per person, plus what is left on installment purchases. */
export function debts(db: DB): Debts {
  const people = new Map<string, { person: string; netCents: number }>();
  let owedToMeCents = 0;
  let iOweCents = 0;
  for (const l of listPersonalLoans(db)) {
    if (l.outstandingCents <= 0) continue;
    const key = personKey(l.person);
    const p = people.get(key) ?? { person: l.person.trim(), netCents: 0 };
    p.netCents += l.direction === "lent" ? l.outstandingCents : -l.outstandingCents;
    people.set(key, p);
    if (l.direction === "lent") owedToMeCents += l.outstandingCents;
    else iOweCents += l.outstandingCents;
  }
  return {
    people: [...people.values()].filter((p) => p.netCents !== 0).sort((a, b) => a.netCents - b.netCents),
    owedToMeCents,
    iOweCents,
    installmentsLeftCents: listInstallmentPlans(db).reduce((a, p) => a + p.remainingCents, 0),
  };
}

/**
 * What is free to spend until the end of the month in progress: the money in
 * the accounts less what still has to leave them. That is unpaid expenses and
 * debits still to come, fixed costs and loans planned but not paid yet, and
 * savings planned but not deposited yet.
 */
export function available(summary: MonthSummary, accounts: Account[], daysLeft: number): Available {
  const accountsCents = accounts.reduce((a, x) => a + x.balanceCents, 0);
  const toPayCents = summary.pendingCents + summary.upcomingCents;
  let fixedLeftCents = 0;
  let dayToDayLeftCents = 0;
  // A Plan line with no category is paid into some other category, so what
  // fixed and credit categories spent beyond their own plan pays for it.
  let untiedCents = 0;
  let beyondPlanCents = 0;
  for (const l of summary.expenses) {
    const left = l.plannedCents - l.actualCents - l.toPayCents;
    if (l.planKey) untiedCents += l.plannedCents;
    else if (l.group === "variable") dayToDayLeftCents += Math.max(0, left);
    else if (left > 0) fixedLeftCents += left;
    else beyondPlanCents -= left;
  }
  fixedLeftCents += Math.max(0, untiedCents - beyondPlanCents);
  const savingsLeftCents = Math.max(0, summary.plannedSavingsCents - summary.savingsCents);
  return {
    accountsCents,
    toPayCents,
    fixedLeftCents,
    savingsLeftCents,
    freeCents: accountsCents - toPayCents - fixedLeftCents - savingsLeftCents,
    daysLeft,
    dayToDayLeftCents,
  };
}

export function netWorth(accounts: Account[], pots: { balanceCents: number }[], d: Debts): NetWorth {
  const accountsCents = accounts.reduce((a, x) => a + x.balanceCents, 0);
  const potsCents = pots.reduce((a, p) => a + p.balanceCents, 0);
  return {
    accountsCents,
    potsCents,
    owedToMeCents: d.owedToMeCents,
    iOweCents: d.iOweCents,
    installmentsLeftCents: d.installmentsLeftCents,
    totalCents: accountsCents + potsCents + d.owedToMeCents - d.iOweCents - d.installmentsLeftCents,
  };
}

/** Things to do for the month shown, most urgent first. */
function todoList(db: DB, summary: MonthSummary, accounts: Account[], today: string, inProgress: boolean): Todo[] {
  const out: Todo[] = [];
  const item = (t: Partial<Todo> & Pick<Todo, "type" | "level">): Todo => ({ name: "", count: 0, amountCents: 0, compareCents: 0, ...t });
  if (summary.previousOpen) out.push(item({ type: "closeMonth", level: "warn", name: summary.previousOpen }));
  if (summary.canClose) out.push(item({ type: "closeMonth", level: "warn", name: summary.month }));

  const loose = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total FROM transactions
       WHERE category_id IS NULL AND paid = 1 AND date >= ? AND date < ?`,
    )
    .get(summary.from, summary.to) as { n: number; total: number };
  if (Number(loose.n) > 0)
    out.push(item({ type: "uncategorised", level: "warn", count: Number(loose.n), amountCents: Number(loose.total) }));

  if (!inProgress) return out;

  if (summary.pending.length)
    out.push(
      item({
        type: "pending",
        level: summary.pending.some((t) => t.date < today) ? "bad" : "warn",
        count: summary.pending.length,
        amountCents: summary.pendingCents,
      }),
    );

  // An account that holds less than what still leaves it this month.
  for (const a of accounts) {
    const owing = [...summary.pending, ...summary.upcoming].filter((x) => x.accountId === a.id).reduce((s, x) => s + x.amountCents, 0);
    if (owing > 0 && a.balanceCents < owing)
      out.push(item({ type: "shortAccount", level: "bad", name: a.name, amountCents: owing - a.balanceCents, compareCents: owing }));
  }

  const soon = summary.upcoming.filter((d) => d.date <= addDays(today, SOON_DAYS)).sort((a, b) => a.date.localeCompare(b.date));
  if (soon.length)
    out.push(
      item({ type: "debitsSoon", level: "info", name: soon[0].name, count: soon.length, amountCents: soon.reduce((s, d) => s + d.amountCents, 0) }),
    );
  return out;
}

/** Everything the overview screen shows for one budget month, with suggestions. */
export function overview(db: DB, month: Month, today: string): Overview {
  const settings = getSettings(db);
  const start = monthStartOf(settings);
  const summary = monthSummary(db, month, today);
  const { from, to } = summary;
  const days = dayIndex(from, to);
  const elapsedDays = today < from ? 0 : today >= to ? days : dayIndex(from, today) + 1;
  const inProgress = elapsedDays > 0 && elapsedDays < days;

  const current = expensesByDay(db, from, to);
  const prev = periodRange(addMonths(month, -1), start);
  const previousCumulativeCents = cumulative(expensesByDay(db, prev.from, prev.to), dayIndex(prev.from, prev.to));

  // Usual spending: the average of earlier months that have any expenses,
  // split into what was spent by this day of the month and what came after.
  const earlier: Spend[][] = [];
  for (let i = 1; i <= USUAL_MONTHS; i++) {
    const r = periodRange(addMonths(month, -i), start);
    const spend = expensesByDay(db, r.from, r.to);
    if (spend.length) earlier.push(spend);
  }
  const usualByCategory = new Map<number | null, number>();
  let usualRestCents = 0;
  for (const spend of earlier) {
    for (const s of spend) {
      if (s.day < elapsedDays) usualByCategory.set(s.categoryId, (usualByCategory.get(s.categoryId) ?? 0) + s.cents);
      else usualRestCents += s.cents;
    }
  }
  const usual = (id: number | null) => (earlier.length ? Math.round((usualByCategory.get(id) ?? 0) / earlier.length) : 0);

  let projectedExpenseCents: number | null = null;
  if (inProgress) {
    projectedExpenseCents = earlier.length
      ? summary.totalExpenseCents + Math.round(usualRestCents / earlier.length)
      : Math.round((summary.totalExpenseCents / elapsedDays) * days);
  }

  const history: Overview["history"] = [];
  for (let i = 5; i >= 0; i--) {
    const m = addMonths(month, -i);
    const r = periodRange(m, start);
    // Paying people back is money out of the month, like an expense.
    const t = totals(db, r.from, r.to);
    const repaid = repaidToPeople(db, r.from, r.to).reduce((a, p) => a + p.cents, 0);
    history.push({ month: m, ...t, expenseCents: t.expenseCents + repaid });
  }

  const tips: Tip[] = [];
  if (elapsedDays > 0) {
    let best: Tip | null = null;
    for (const line of summary.expenses) {
      const { name, actualCents: actual, plannedCents: planned } = line;
      if (line.categoryId == null) continue;
      const u = usual(line.categoryId);
      if (planned > 0 && actual > planned) {
        tips.push({ type: "overBudget", level: "bad", name, amountCents: actual, compareCents: planned });
      } else if (planned === 0 && actual >= 1000) {
        tips.push({ type: "unplanned", level: "warn", name, amountCents: actual, compareCents: 0 });
      } else if (u > 0 && actual >= u * 1.3 && actual - u >= 2000) {
        tips.push({ type: "aboveUsual", level: "warn", name, amountCents: actual, compareCents: u });
      } else if (u >= 3000 && actual <= u * 0.7 && (!best || u - actual > best.compareCents - best.amountCents)) {
        best = { type: "belowUsual", level: "good", name, amountCents: actual, compareCents: u };
      }
    }
    if (best) tips.push(best);

    if (summary.plannedSavingsCents > 0 && elapsedDays / days >= 0.8 && summary.savingsCents < summary.plannedSavingsCents) {
      tips.push({
        type: "savingsBehind",
        level: "warn",
        name: "",
        amountCents: summary.savingsCents,
        compareCents: summary.plannedSavingsCents,
      });
    }

    const [, nextMonth] = parseMonth(addMonths(month, 1));
    for (const item of listPlanItems(db)) {
      if (item.section === "annual" && item.month === nextMonth && item.amountCents > 0) {
        tips.push({ type: "annualNext", level: "info", name: item.name, amountCents: item.amountCents, compareCents: 0 });
      }
    }
  }
  const order = { bad: 0, warn: 1, info: 2, good: 3 };
  tips.sort(
    (a, b) => order[a.level] - order[b.level] || Math.abs(b.amountCents - b.compareCents) - Math.abs(a.amountCents - a.compareCents),
  );

  const accounts = listAccounts(db);
  const pots = listPots(db);
  const owing = debts(db);
  // Unlike inProgress, this includes the month's last day.
  const isCurrent = today >= from && today < to;
  const todo = todoList(db, summary, accounts, today, isCurrent);
  // Suggestions that aren't about one category are things to do.
  for (const tip of tips)
    if (tip.type === "savingsBehind" || tip.type === "annualNext")
      todo.push({ type: tip.type, level: tip.level === "info" ? "info" : "warn", name: tip.name, count: 0, amountCents: tip.amountCents, compareCents: tip.compareCents });

  return {
    summary,
    days,
    elapsedDays,
    cumulativeCents: cumulative(current, elapsedDays),
    previousCumulativeCents,
    projectedExpenseCents,
    history,
    pots,
    tips: tips.filter((t) => t.type !== "savingsBehind" && t.type !== "annualNext"),
    debts: owing,
    available: isCurrent ? available(summary, accounts, days - elapsedDays + 1) : null,
    todo,
    netWorth: netWorth(accounts, pots, owing),
  };
}
