// The monthly transfer from the account the salary comes into (e.g. Montepio)
// to each other account (e.g. Revolut), so that account can pay what the Plan
// says it pays in the budget month the salary funds (salary of month M pays
// for M+1): every monthly item (fixed costs, subscriptions, investments,
// donations), the annual items paid in that month, the monthly payment of
// bank loans not paid off, what is planned for the day-to-day categories
// spent from that account, and unpaid installments due in it.
import type { DB } from "./db.ts";
import { getSettings, listAccounts, listCategories, listLoans, listPending, listPlanItems, listTransfers, monthPlans } from "./store.ts";
import { monthStartOf, parseMonth, periodRange, type Month } from "../shared/period.ts";
import type { TransferNeed, TransferPlan } from "../shared/types.ts";

/** The account the salary comes into: the setting, or the account of the latest salary entry, or the default one. */
export function salaryAccount(db: DB): number {
  const accounts = listAccounts(db);
  const set = getSettings(db).salaryAccountId;
  if (set != null && accounts.some((a) => a.id === set)) return set;
  const last = db
    .prepare(
      `SELECT t.account_id FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.kind = 'income' AND t.account_id IS NOT NULL AND lower(c.name) IN ('salário', 'salario', 'salary')
       ORDER BY t.date DESC, t.id DESC LIMIT 1`,
    )
    .get() as { account_id: number } | undefined;
  if (last) return Number(last.account_id);
  return accounts.find((a) => a.isDefault)!.id;
}

export function transferPlan(db: DB, month: Month): TransferPlan {
  const { from, to } = periodRange(month, monthStartOf(getSettings(db)));
  const accounts = listAccounts(db);
  const defaultId = accounts.find((a) => a.isDefault)!.id;
  const salaryAccountId = salaryAccount(db);
  const [, month1] = parseMonth(month);

  const needs = new Map<number, TransferNeed>();
  const need = (accountId: number) => {
    let n = needs.get(accountId);
    if (!n) {
      const a = accounts.find((x) => x.id === accountId)!;
      n = { accountId, neededCents: 0, balanceCents: a.balanceCents, parts: [], transfer: null };
      needs.set(accountId, n);
    }
    return n;
  };
  const part = (accountId: number, p: TransferNeed["parts"][number]) => {
    if (accountId === salaryAccountId || p.cents <= 0) return;
    const n = need(accountId);
    n.parts.push(p);
    n.neededCents += p.cents;
  };

  for (const i of listPlanItems(db)) {
    if (i.section === "annual" && i.month !== month1) continue;
    part(i.accountId ?? defaultId, { name: i.name, cents: i.amountCents, kind: i.section });
  }
  // Day-to-day categories: what is planned for them that month. Those tied to a Plan line are already counted.
  const tied = new Set([...listPlanItems(db), ...listLoans(db)].map((i) => i.categoryId));
  const plans = monthPlans(db, month);
  for (const c of listCategories(db))
    if (c.kind === "expense" && c.group === "variable" && c.accountId != null && !c.archived && !tied.has(c.id))
      part(c.accountId, { name: c.name, cents: plans.categories.get(c.id) ?? c.plannedCents, kind: "category" });
  for (const l of listLoans(db))
    if (!l.paidOff) part(l.accountId ?? defaultId, { name: l.name, cents: l.monthlyCents, kind: "loan" });
  // Installments are not in the Plan; the ones due this month are paid from their account.
  for (const t of listPending(db, to))
    if (t.date >= from) part(t.accountId, { name: t.description, cents: t.amountCents, kind: "unpaid" });

  for (const t of listTransfers(db, {}))
    if (t.budgetMonth === month && t.toAccountId !== salaryAccountId) need(t.toAccountId).transfer = t;

  return {
    month,
    payday: from,
    salaryAccountId,
    needs: [...needs.values()]
      .filter((n) => n.neededCents > 0 || n.transfer)
      .sort((a, b) => accounts.findIndex((x) => x.id === a.accountId) - accounts.findIndex((x) => x.id === b.accountId)),
  };
}
