import type { DB } from "./db.ts";
import { getClose, getSettings, listCategories, listLoans, listPending, listPersonalLoans, listPlanItems, listPots, monthPlans, personKey } from "./store.ts";
import { addMonths, monthOf, monthStartOf, parseMonth, periodRange, todayISO, type Month } from "../shared/period.ts";
import { upcomingDebits } from "./subscriptions.ts";
import type { BalanceReport, Category, BalanceRow, ExpenseGroup, MonthSummary, PlanCell, PlanGrid, PlanMonth, PlanRow, SummaryLine } from "../shared/types.ts";

type SumRow = { category_id: number | null; total: number };

function sumsByCategory(db: DB, kind: string, from: string, to: string): Map<number | null, number> {
  const rows = db
    .prepare(
      `SELECT category_id, SUM(amount_cents) AS total FROM transactions
       WHERE kind = ? AND paid = 1 AND date >= ? AND date < ? GROUP BY category_id`,
    )
    .all(kind, from, to) as SumRow[];
  return new Map(rows.map((r) => [r.category_id == null ? null : Number(r.category_id), Number(r.total)]));
}

function savingsBetween(db: DB, from: string, to: string): number {
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM savings_movements WHERE amount_cents > 0 AND opening = 0 AND scheduled = 0 AND date >= ? AND date < ?",
    )
    .get(from, to) as { total: number };
  return Number(row.total);
}

/**
 * What I paid back to each person I borrowed from, in [from, to). Borrowing
 * itself counts in no month: the money only counts when it is paid back.
 */
export function repaidToPeople(db: DB, from: string, to: string): { person: string; cents: number }[] {
  const people = new Map<string, { person: string; cents: number }>();
  for (const l of listPersonalLoans(db)) {
    if (l.direction !== "borrowed") continue;
    for (const p of l.payments) {
      if (p.scheduled || p.date < from || p.date >= to) continue;
      const key = personKey(l.person);
      const r = people.get(key) ?? { person: l.person.trim(), cents: 0 };
      r.cents += p.amountCents;
      people.set(key, r);
    }
  }
  return [...people.values()].sort((a, b) => b.cents - a.cents);
}

/**
 * What I will pay back to each person I borrowed from in [from, to): the
 * repayments dated ahead in it, and what is still owed with a "due by" date in
 * it. With `overdue`, also what fell due before and is still unpaid, like the
 * current month carries over unpaid entries.
 */
export function repaymentsDue(db: DB, from: string, to: string, overdue: boolean): { person: string; cents: number }[] {
  const people = new Map<string, { person: string; cents: number }>();
  const inMonth = (date: string) => date < to && (overdue || date >= from);
  for (const l of listPersonalLoans(db)) {
    if (l.direction !== "borrowed") continue;
    // A repayment dated ahead is already out of what is owed, so the two never overlap.
    let cents = l.payments.filter((p) => p.scheduled && inMonth(p.date)).reduce((a, p) => a + p.amountCents, 0);
    if (l.outstandingCents > 0 && l.dueDate != null && inMonth(l.dueDate)) cents += l.outstandingCents;
    if (!cents) continue;
    const key = personKey(l.person);
    const r = people.get(key) ?? { person: l.person.trim(), cents: 0 };
    r.cents += cents;
    people.set(key, r);
  }
  return [...people.values()].sort((a, b) => b.cents - a.cents);
}

type PlanLine = { key: string; name: string; cents: number; categoryId: number | null; group: ExpenseGroup; accountId: number | null };

/**
 * What the Plan says is paid in a budget month, like the transfer plan: every
 * monthly line (fixed costs, subscriptions, investments, donations), the
 * annual lines paid that month and the monthly payment of bank loans not paid
 * off. Each counts in its category; one without stays a line of its own
 * (subscriptions without one count in "Subscrições", where they are debited).
 */
function planLines(db: DB, month: Month, categories: Category[]): PlanLine[] {
  const [, month1] = parseMonth(month);
  const subs = categories.find((c) => c.kind === "expense" && c.name.toLowerCase() === "subscrições")?.id ?? null;
  const out: PlanLine[] = [];
  const SECTIONS = ["fixed", "subscription", "investment", "donation", "annual"];
  const items = listPlanItems(db).sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section));
  for (const i of items) {
    if (i.section === "annual" && i.month !== month1) continue;
    if (!i.amountCents) continue;
    const categoryId = i.categoryId ?? (i.section === "subscription" ? subs : null);
    out.push({ key: `plan-${i.id}`, name: i.name, cents: i.amountCents, categoryId, group: "fixed", accountId: i.accountId });
  }
  for (const l of listLoans(db))
    if (!l.paidOff && l.monthlyCents)
      out.push({ key: `loan-${l.id}`, name: l.name, cents: l.monthlyCents, categoryId: l.categoryId, group: "credit", accountId: l.accountId });
  return out;
}

/** What the Plan lines tied to each category add up to, and their names. */
function plannedByCategory(lines: PlanLine[]) {
  const out = new Map<number, { cents: number; names: string[] }>();
  for (const l of lines) {
    if (l.categoryId == null) continue;
    const r = out.get(l.categoryId) ?? { cents: 0, names: [] };
    r.cents += l.cents;
    r.names.push(l.name);
    out.set(l.categoryId, r);
  }
  return out;
}

/**
 * The accounts each expense category is paid from in a period: those of its
 * entries and debits, or else of the Plan lines tied to it.
 */
function accountsByCategory(db: DB, from: string, to: string, categories: Category[], owing: { categoryId: number | null; accountId: number }[]) {
  const DEFAULT = "(SELECT id FROM accounts WHERE is_default = 1)";
  const out = new Map<number | null, Set<number>>();
  const add = (c: number | null, a: number | null) => {
    if (a == null) return;
    if (!out.has(c)) out.set(c, new Set());
    out.get(c)!.add(Number(a));
  };
  const rows = db
    .prepare(
      `SELECT DISTINCT category_id, COALESCE(account_id, ${DEFAULT}) AS account_id FROM transactions
       WHERE kind = 'expense' AND date >= ? AND date < ?`,
    )
    .all(from, to) as { category_id: number | null; account_id: number | null }[];
  for (const r of rows) add(r.category_id == null ? null : Number(r.category_id), r.account_id);
  for (const x of owing) add(x.categoryId, x.accountId);
  const planned = db
    .prepare(`SELECT DISTINCT category_id, COALESCE(account_id, ${DEFAULT}) AS account_id FROM plan_items WHERE category_id IS NOT NULL`)
    .all() as { category_id: number; account_id: number | null }[];
  for (const r of planned) if (!out.has(Number(r.category_id))) add(Number(r.category_id), r.account_id);
  const loans = db
    .prepare(`SELECT DISTINCT category_id, COALESCE(account_id, ${DEFAULT}) AS account_id FROM loans WHERE category_id IS NOT NULL AND paid_off = 0`)
    .all() as { category_id: number; account_id: number | null }[];
  for (const r of loans) if (!out.has(Number(r.category_id))) add(Number(r.category_id), r.account_id);
  // A day-to-day category is spent from the account chosen for it.
  for (const c of categories) if (c.group === "variable" && c.accountId != null) add(c.id, c.accountId);
  return out;
}

/** The "Sumário" sheet: planned vs actual per category for one budget month. */
export function monthSummary(db: DB, month: Month, today = todayISO()): MonthSummary {
  const settings = getSettings(db);
  const { salaryCents } = settings;
  const { from, to } = periodRange(month, monthStartOf(settings));
  const categories = listCategories(db);
  const plans = monthPlans(db, month);
  const plannedSavingsCents = plans.savingsCents ?? settings.plannedSavingsCents;
  const fromPlan = planLines(db, month, categories);
  const tied = plannedByCategory(fromPlan);
  const defaultAccount = (db.prepare("SELECT id FROM accounts WHERE is_default = 1").get() as { id: number } | undefined)?.id;

  const upcoming = upcomingDebits(db, from, to, today);
  const pending = listPending(db, to).map((t) => ({ ...t, dueMonth: monthOf(t.date, monthStartOf(settings)) }));
  const toPay = new Map<number | null, number>();
  for (const x of [...pending, ...upcoming]) toPay.set(x.categoryId, (toPay.get(x.categoryId) ?? 0) + x.amountCents);

  const accounts = accountsByCategory(db, from, to, categories, [...pending, ...upcoming]);
  const accountsOf = (kind: "expense" | "income", c: number | null) => (kind === "expense" ? [...(accounts.get(c) ?? [])] : []);

  const lines = (kind: "expense" | "income"): SummaryLine[] => {
    const sums = sumsByCategory(db, kind, from, to);
    const owing = kind === "expense" ? toPay : new Map<number | null, number>();
    const out: SummaryLine[] = categories
      .filter((c) => c.kind === kind && (!c.archived || sums.has(c.id) || owing.has(c.id) || tied.has(c.id)))
      .map((c) => ({
        categoryId: c.id,
        name: c.name,
        group: c.group,
        accountIds: accountsOf(kind, c.id),
        // The month's own amount, or what its Plan lines add up to, or its usual amount.
        plannedCents: plans.categories.get(c.id) ?? tied.get(c.id)?.cents ?? c.plannedCents,
        actualCents: sums.get(c.id) ?? 0,
        toPayCents: owing.get(c.id) ?? 0,
        fromPlan: tied.get(c.id)?.names ?? [],
      }));
    if (kind === "expense")
      for (const l of fromPlan)
        if (l.categoryId == null)
          out.push({
            categoryId: null,
            planKey: l.key,
            name: l.name,
            group: l.group,
            accountIds: [l.accountId ?? defaultAccount].filter((a): a is number => a != null),
            plannedCents: l.cents,
            actualCents: 0,
            toPayCents: 0,
            fromPlan: [],
          });
    const uncategorised = sums.get(null) ?? 0;
    const uncategorisedToPay = owing.get(null) ?? 0;
    if (uncategorised || uncategorisedToPay)
      out.push({ categoryId: null, name: "", group: "variable", accountIds: accountsOf(kind, null), plannedCents: 0, actualCents: uncategorised, toPayCents: uncategorisedToPay, fromPlan: [] });
    return out;
  };

  const expenses = lines("expense");
  const income = lines("income");
  const sum = (xs: SummaryLine[], k: "plannedCents" | "actualCents") =>
    xs.reduce((a, x) => a + x[k], 0);

  const savingsCents = savingsBetween(db, from, to);
  const totalExpenseCents = sum(expenses, "actualCents");
  const totalIncomeCents = sum(income, "actualCents");
  const plannedIncome = sum(income, "plannedCents");
  const repaid = repaidToPeople(db, from, to);
  const repaidCents = repaid.reduce((a, p) => a + p.cents, 0);
  const close = getClose(db, month);
  const current = monthOf(today, monthStartOf(settings));
  // Still to pay back to people this month; past months only count what was paid.
  const repaidDue = month < current ? [] : repaymentsDue(db, from, to, month === current);
  const previous = addMonths(month, -1);
  const previousHasEntries = () => {
    const r = periodRange(previous, monthStartOf(settings));
    return db.prepare("SELECT 1 FROM transactions WHERE paid = 1 AND date >= ? AND date < ? LIMIT 1").get(r.from, r.to) != null;
  };

  return {
    month,
    from,
    to,
    expenses,
    income,
    savingsCents,
    plannedSavingsCents,
    totalExpenseCents,
    totalIncomeCents,
    plannedExpenseCents: sum(expenses, "plannedCents"),
    plannedIncomeCents: plannedIncome || salaryCents,
    balanceCents: totalIncomeCents - totalExpenseCents - savingsCents - repaidCents,
    savingsTotalCents: listPots(db).reduce((a, p) => a + p.balanceCents, 0),
    pending,
    pendingCents: pending.reduce((a, t) => a + t.amountCents, 0),
    upcoming,
    upcomingCents: upcoming.reduce((a, d) => a + d.amountCents, 0),
    repaid,
    repaidCents,
    repaidDue,
    repaidDueCents: repaidDue.reduce((a, p) => a + p.cents, 0),
    close,
    canClose: !close && month < current,
    previousOpen: month === current && !getClose(db, previous) && previousHasEntries() ? previous : null,
  };
}

/**
 * The planning sheet: what is planned (and spent) per category in each of
 * `count` budget months from `first`, and what is left at the end of each.
 * Past months count what really happened. The current month counts the
 * larger of the plan and what is spent or still to pay; later months count
 * the plan, or more if more is already due. Money paid back to people counts
 * in the month it is paid, never in the month it was borrowed.
 */
export function planGrid(db: DB, first: Month, count: number, today = todayISO()): PlanGrid {
  const settings = getSettings(db);
  const start = monthStartOf(settings);
  const current = monthOf(today, start);
  const categories = listCategories(db);
  const months: PlanMonth[] = [];
  const byKey = new Map<string, PlanRow>();
  const row = (key: string, kind: PlanRow["kind"], categoryId: number | null, name: string, group: PlanRow["group"] = "variable") => {
    let r = byKey.get(key);
    if (!r) {
      r = { key, kind, categoryId, name, group, cells: [], fromPlan: [] };
      byKey.set(key, r);
    }
    return r;
  };
  const empty = (): PlanCell => ({ plannedCents: 0, actualCents: 0, toPayCents: 0, custom: false });

  for (let i = 0; i < count; i++) {
    const month = addMonths(first, i);
    const { from, to } = periodRange(month, start);
    const status: PlanMonth["status"] = month < current ? "past" : month === current ? "current" : "future";
    const plans = monthPlans(db, month);
    const fromPlan = planLines(db, month, categories);
    const tied = plannedByCategory(fromPlan);
    const toPay = new Map<number | null, number>();
    if (status !== "past") {
      // Later months only count what falls due in them, not what is carried over.
      const pending = listPending(db, to).filter((t) => status === "current" || t.date >= from);
      for (const x of [...pending, ...upcomingDebits(db, from, to, today)])
        toPay.set(x.categoryId, (toPay.get(x.categoryId) ?? 0) + x.amountCents);
    }
    const cost = (c: PlanCell) =>
      status === "past" ? c.actualCents : Math.max(c.plannedCents, c.actualCents + c.toPayCents);

    let incomeCents = 0;
    let spentCents = 0;
    for (const kind of ["income", "expense"] as const) {
      const sums = sumsByCategory(db, kind, from, to);
      for (const c of categories.filter((c) => c.kind === kind)) {
        const cell: PlanCell = {
          plannedCents: plans.categories.get(c.id) ?? tied.get(c.id)?.cents ?? c.plannedCents,
          actualCents: sums.get(c.id) ?? 0,
          toPayCents: kind === "expense" ? (toPay.get(c.id) ?? 0) : 0,
          custom: plans.categories.has(c.id),
        };
        const r = row(`cat-${c.id}`, kind, c.id, c.name, c.group);
        r.cells[i] = cell;
        for (const n of tied.get(c.id)?.names ?? []) if (!r.fromPlan.includes(n)) r.fromPlan.push(n);
        if (kind === "income") incomeCents += cost(cell);
        else spentCents += cost(cell);
      }
      if (kind === "expense")
        for (const l of fromPlan) {
          if (l.categoryId != null) continue;
          const cell = { ...empty(), plannedCents: l.cents };
          const r = row(l.key, kind, null, l.name, l.group);
          r.planLine = true;
          r.cells[i] = cell;
          spentCents += cost(cell);
        }
      const loose = sums.get(null) ?? 0;
      const looseToPay = kind === "expense" ? (toPay.get(null) ?? 0) : 0;
      if (loose || looseToPay) {
        const cell = { ...empty(), actualCents: loose, toPayCents: looseToPay };
        row(`none-${kind}`, kind, null, "").cells[i] = cell;
        if (kind === "income") incomeCents += cost(cell);
        else spentCents += cost(cell);
      }
    }
    if (!incomeCents && status !== "past") incomeCents = settings.salaryCents;

    const savings: PlanCell = {
      plannedCents: plans.savingsCents ?? settings.plannedSavingsCents,
      actualCents: savingsBetween(db, from, to),
      toPayCents: 0,
      custom: plans.savingsCents != null,
    };
    row("savings", "savings", null, "").cells[i] = savings;
    spentCents += cost(savings);

    const repaidRow = (person: string) => {
      const r = row(`repaid-${personKey(person)}`, "repaid", null, person);
      return (r.cells[i] ??= empty());
    };
    for (const r of repaidToPeople(db, from, to)) repaidRow(r.person).actualCents = r.cents;
    if (status !== "past") for (const r of repaymentsDue(db, from, to, status === "current")) repaidRow(r.person).toPayCents = r.cents;
    for (const r of byKey.values())
      if (r.kind === "repaid" && r.cells[i]) spentCents += cost(r.cells[i]);

    months.push({ month, status, incomeCents, endCents: incomeCents - spentCents });
  }

  const rows = [...byKey.values()];
  for (const r of rows) for (let i = 0; i < count; i++) r.cells[i] ??= empty();
  // Archived categories only while they have something in these months.
  const archived = new Set(categories.filter((c) => c.archived).map((c) => c.id));
  return {
    months,
    rows: rows.filter(
      (r) =>
        r.categoryId == null || !archived.has(r.categoryId) || r.fromPlan.length > 0 || r.cells.some((c) => c.actualCents || c.toPayCents || c.custom),
    ),
  };
}

/** The "Balanço" and "Estatísticas" sheets: month-by-month totals and yearly averages. */
export function balanceReport(db: DB): BalanceReport {
  const start = monthStartOf(getSettings(db));
  const categories = listCategories(db)
    .filter((c) => c.kind === "expense")
    .map((c) => ({ id: c.id, name: c.name }));

  const bounds = db
    .prepare(
      `SELECT MIN(d) AS first, MAX(d) AS last FROM (
         SELECT date AS d FROM transactions WHERE paid = 1 UNION ALL SELECT date FROM savings_movements WHERE amount_cents > 0 AND opening = 0 AND scheduled = 0)`,
    )
    .get() as { first: string | null; last: string | null };
  const months: BalanceRow[] = [];
  if (bounds.first && bounds.last) {
    const last = monthOf(bounds.last, start);
    let m = monthOf(bounds.first, start);
    for (let guard = 0; m <= last && guard < 600; guard++, m = addMonths(m, 1)) {
      const { from, to } = periodRange(m, start);
      const exp = sumsByCategory(db, "expense", from, to);
      const inc = sumsByCategory(db, "income", from, to);
      const expenseCents = [...exp.values()].reduce((a, b) => a + b, 0);
      const incomeCents = [...inc.values()].reduce((a, b) => a + b, 0);
      const savingsCents = savingsBetween(db, from, to);
      const byCategory: Record<number, number> = {};
      for (const [id, v] of exp) if (id != null) byCategory[id] = v;
      if (!expenseCents && !incomeCents && !savingsCents) continue;
      months.push({
        month: m,
        incomeCents,
        expenseCents,
        savingsCents,
        balanceCents: incomeCents - expenseCents - savingsCents,
        byCategory,
      });
    }
  }

  // Like the spreadsheet's "Média Anual": calendar-year total divided by 12.
  const yearly = db
    .prepare(
      `SELECT CAST(substr(date, 1, 4) AS INTEGER) AS year, category_id, SUM(amount_cents) AS total
       FROM transactions WHERE kind = 'expense' AND paid = 1 AND category_id IS NOT NULL
       GROUP BY year, category_id ORDER BY year`,
    )
    .all() as { year: number; category_id: number; total: number }[];
  const byYear = new Map<number, Record<number, number>>();
  for (const r of yearly) {
    const rec = byYear.get(r.year) ?? {};
    rec[Number(r.category_id)] = Math.round(Number(r.total) / 12);
    byYear.set(r.year, rec);
  }

  return {
    months: months.reverse(),
    categories,
    yearlyAverages: [...byYear.entries()].map(([year, byCategory]) => ({ year, byCategory })),
  };
}
