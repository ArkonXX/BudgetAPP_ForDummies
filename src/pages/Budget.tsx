import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../App";
import { useI18n, type Lang } from "../i18n";
import { dateLabel, monthLabel } from "../format";
import { addMonths, todayISO } from "../../shared/period";
import CloseMonth, { monthName } from "../CloseMonth";
import { EXPENSE_GROUPS, Loading, Money, MonthNav, PlannedInput, Section, SpentFromSelect, useLoad } from "../components";
import type { MonthClose, MonthSummary, SummaryLine } from "../../shared/types";

type Row = { key: string; name: string; plannedCents: number; actualCents: number; line?: SummaryLine };

/** An amount, or an empty cell for zero so the numbers that matter stand out. */
function Amount({ cents, signed }: { cents: number; signed?: boolean }) {
  return cents ? <Money cents={cents} signed={signed} /> : null;
}

/**
 * One table of the month's budget, like the spreadsheet's Sumário: what is
 * planned, what is spent (or received) and what is left, per category. The
 * Budget shows one per group of expenses, one for income and one for
 * savings. Unpaid expenses and money paid back to people are shown elsewhere.
 */
function BudgetTable({
  month,
  lines,
  savings,
  editing,
  income,
  pickAccount,
  onSaved,
}: {
  month: string;
  lines: SummaryLine[];
  savings?: Row;
  editing: boolean;
  income?: boolean;
  pickAccount?: boolean; // day-to-day spending: choose the account each category is spent from
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { accounts, categories, refresh } = useApp();
  const setAccount = async (categoryId: number, accountId: number | null) => {
    const c = categories.find((x) => x.id === categoryId);
    if (!c) return;
    await api.post("/categories", { ...c, accountId });
    await refresh();
    onSaved();
  };
  // Only worth naming the account when there is more than one.
  const accountNames = (l?: SummaryLine) =>
    accounts.length > 1 && l ? l.accountIds.map((id) => accounts.find((a) => a.id === id)?.name).filter(Boolean).join(", ") : "";
  const toRow = (l: SummaryLine): Row => ({
    key: String(l.categoryId ?? "none"),
    name: l.name || t("uncategorised"),
    plannedCents: l.plannedCents,
    actualCents: l.actualCents,
    line: l,
  });
  const used = (r: Row) => r.plannedCents || r.actualCents;
  // Hide empty rows unless editing, like the spreadsheet's unused categories.
  const rows = (editing ? lines.filter((l) => l.categoryId != null) : lines).map(toRow).filter((r) => editing || used(r));
  const all = [...rows, ...(savings ? [savings] : [])];
  // Expenses: what is left to spend. Income: what is still to come in.
  const leftOf = (r: { plannedCents: number; actualCents: number }) =>
    income ? Math.max(0, r.plannedCents - r.actualCents) : r.plannedCents - r.actualCents;
  const total = {
    plannedCents: all.reduce((a, r) => a + r.plannedCents, 0),
    actualCents: all.reduce((a, r) => a + r.actualCents, 0),
  };

  const row = (r: Row, editable: boolean) => (
    <tr key={r.key}>
      <td className="sticky">
        <span className="budget-name">{r.name}</span>
        {editing && pickAccount && r.line?.categoryId != null ? (
          <SpentFromSelect
            value={categories.find((c) => c.id === r.line!.categoryId)?.accountId ?? null}
            onChange={(id) => setAccount(r.line!.categoryId!, id)}
          />
        ) : (
          accountNames(r.line) && <span className="budget-account muted">{accountNames(r.line)}</span>
        )}
      </td>
      <td className="num">
        {editing && editable ? (
          <PlannedInput month={month} categoryId={r.line?.categoryId ?? null} cents={r.plannedCents} onSaved={onSaved} />
        ) : (
          <Amount cents={r.plannedCents} />
        )}
      </td>
      <td className="num">
        <Amount cents={r.actualCents} />
      </td>
      <td className="num left-col">
        <Amount cents={leftOf(r)} signed={!income} />
      </td>
    </tr>
  );

  return (
    <>
      <div className="table-wrap">
        <table className="budget-table">
          <thead>
            <tr>
              <th className="sticky">{t("category")}</th>
              <th className="num">{t("planned")}</th>
              <th className="num">{income ? t("received") : t("spent")}</th>
              <th className="num">{income ? t("stillToReceive") : t("leftToSpend")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => row(r, r.line?.categoryId != null))}
            {savings && row(savings, true)}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky">{t("total")}</td>
              <td className="num">
                <Money cents={total.plannedCents} />
              </td>
              <td className="num">
                <Money cents={total.actualCents} />
              </td>
              <td className="num left-col">
                <Money cents={leftOf(total)} signed={!income} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

const sum = (lines: SummaryLine[], key: "plannedCents" | "actualCents") => lines.reduce((a, l) => a + l[key], 0);

/**
 * The sums of the month, like the bottom of the spreadsheet: income minus
 * each table above, planned and actual, down to what is left over.
 */
function MonthSums({ data, groups }: { data: MonthSummary; groups: { label: string; lines: SummaryLine[] }[] }) {
  const { t, lang } = useI18n();
  const rows: { key: string; label: string; planned: number | null; actual: number; minus?: boolean }[] = [
    { key: "income", label: t("incomes"), planned: data.plannedIncomeCents, actual: data.totalIncomeCents },
    ...(data.carriedInCents
      ? [{ key: "carried", label: t("carriedInFrom", { month: monthName(addMonths(data.month, -1), lang) }), planned: data.carriedInCents, actual: data.carriedInCents }]
      : []),
    ...groups.map((g) => ({ key: g.label, label: g.label, planned: sum(g.lines, "plannedCents"), actual: sum(g.lines, "actualCents"), minus: true })),
    { key: "savings", label: t("savingsGroup"), planned: data.plannedSavingsCents, actual: data.savingsCents, minus: true },
    ...(data.repaidCents ? [{ key: "repaid", label: t("repaidTitle"), planned: null, actual: data.repaidCents, minus: true }] : []),
  ];
  const left = (k: "planned" | "actual") => rows.reduce((a, r) => a + (r[k] ?? 0) * (r.minus ? -1 : 1), 0);
  const cell = (cents: number | null, minus?: boolean) =>
    cents == null ? <span className="muted">–</span> : <Money cents={minus && cents ? -cents : cents} signed={minus && cents !== 0} />;
  return (
    <Section title={t("monthSums")}>
      <div className="table-wrap">
        <table className="budget-table sums-table">
          <thead>
            <tr>
              <th className="sticky" />
              <th className="num">{t("planned")}</th>
              <th className="num">{t("actual")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="sticky">
                  <span className="budget-name">{r.label}</span>
                </td>
                <td className="num">{cell(r.planned, r.minus)}</td>
                <td className="num">{cell(r.actual, r.minus)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="sticky">{t("leftOver")}</td>
              <td className={`num ${left("planned") < 0 ? "neg" : "pos"}`}>
                <Money cents={left("planned")} />
              </td>
              <td className={`num ${data.balanceCents < 0 ? "neg" : "pos"}`}>
                <Money cents={data.balanceCents} />
              </td>
            </tr>
            {data.pendingCents + data.upcomingCents > 0 && (
              <tr className="after-row">
                <td className="sticky">{t("leftOverAfterPending")}</td>
                <td />
                <td className={`num ${data.balanceCents - data.pendingCents - data.upcomingCents < 0 ? "neg" : ""}`}>
                  <Money cents={data.balanceCents - data.pendingCents - data.upcomingCents} />
                </td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>
      <p className="muted small budget-help">{t("monthSumsHelp")}</p>
    </Section>
  );
}

function Pending({ data, onPaid }: { data: MonthSummary; onPaid: () => void }) {
  const { t, lang } = useI18n();
  const { categories } = useApp();
  const [busy, setBusy] = useState<number | null>(null);
  const pay = async (id: number) => {
    setBusy(id);
    try {
      await api.post(`/transactions/${id}/pay`, { date: todayISO() });
      onPaid();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section title={t("pendingTitle")} action={<span className="small neg"><Money cents={data.pendingCents} /></span>}>
      <ul className="budget-lines">
        {data.pending.map((p) => (
          <li key={p.id}>
            <div className="budget-row">
              <span className="budget-name">
                {p.description || categories.find((c) => c.id === p.categoryId)?.name || t("noCategory")}
                {p.installment && <span className="muted"> ({p.installment.seq}/{p.installment.count})</span>}
                {p.dueMonth < data.month && (
                  <span className="muted small"> · {t("carriedFrom", { month: lang === "pt" ? monthLabel(p.dueMonth, lang).toLowerCase() : monthLabel(p.dueMonth, lang) })}</span>
                )}
              </span>
              <span className="budget-nums">
                <Money cents={p.amountCents} />{" "}
                <button className="btn small-btn" disabled={busy === p.id} onClick={() => pay(p.id)}>
                  {t("markPaid")}
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Upcoming({ data }: { data: MonthSummary }) {
  const { t, lang } = useI18n();
  return (
    <Section title={t("upcomingTitle")} action={<span className="small muted"><Money cents={data.upcomingCents} /></span>}>
      <ul className="budget-lines">
        {data.upcoming.map((d) => (
          <li key={`${d.itemId}-${d.date}`}>
            <div className="budget-row">
              <span className="budget-name">
                {d.name}
                <span className="muted small"> · {dateLabel(d.date, lang)}</span>
              </span>
              <span className="budget-nums">
                <Money cents={d.amountCents} />
              </span>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Money paid back to people this month: it counts here, not when it was borrowed. */
function Repaid({ data }: { data: MonthSummary }) {
  const { t } = useI18n();
  return (
    <Section title={t("repaidTitle")} action={<span className="small"><Money cents={-data.repaidCents} signed /></span>}>
      <ul className="budget-lines">
        {data.repaid.map((r) => (
          <li key={r.person}>
            <div className="budget-row">
              <span className="budget-name">
                <Link to="/loans">{r.person}</Link>
              </span>
              <span className="budget-nums">
                <Money cents={r.cents} />
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">{t("repaidHelp")}</p>
    </Section>
  );
}

/** A closed month: where its leftover went and the balances that were set, with a way to reopen it. */
function Closed({ data, close, onReopened }: { data: MonthSummary; close: MonthClose; onReopened: () => void }) {
  const { t, lang } = useI18n();
  const { accounts } = useApp();
  const { data: savings } = useLoad(() => api.get<{ pots: { id: number; name: string }[] }>("/savings"), []);
  const next = monthName(addMonths(data.month, 1), lang);
  const pot = savings?.pots.find((p) => p.id === close.potId)?.name ?? "";
  const reopen = async () => {
    if (!confirm(t("reopenConfirm", { month: monthName(data.month, lang) }))) return;
    await api.del(`/month-close/${data.month}`);
    onReopened();
  };
  return (
    <section className="card closed-card">
      <div className="card-head">
        <h2>{t("monthClosed")}</h2>
        {data.canReopen && (
          <button className="btn small-btn" onClick={reopen}>
            {t("reopen")}
          </button>
        )}
      </div>
      <p className="small">
        {t("closedOn", { date: dateLabel(close.closedAt, lang) })} ·{" "}
        {close.balanceCents < 0 ? t("closeShortfall") : t("closeLeftover")} <Money cents={Math.abs(close.balanceCents)} />
      </p>
      {close.potCents > 0 && (
        <p className="small">
          {close.balanceCents > 0 ? t("closedToPot", { pot }) : t("closedFromPot", { pot })} <Money cents={close.potCents} />
        </p>
      )}
      {close.carryCents !== 0 && (
        <p className="small">
          {t("closedCarried", { month: next })} <Money cents={close.carryCents} signed />
        </p>
      )}
      {close.adjustments.map((a) => (
        <p key={a.id} className="small muted">
          {t("closedAdjusted", { account: accounts.find((x) => x.id === a.accountId)?.name ?? "" })} <Money cents={a.amountCents} signed />
        </p>
      ))}
      <p className="muted small">{t("closedHelp")}</p>
    </section>
  );
}

/** The day before an exclusive end date. */
function lastDay(to: string): string {
  return new Date(Date.parse(to) - 86400_000).toISOString().slice(0, 10);
}

/**
 * The salary that pays for a budget month is the one received at the end of
 * the month before (October's salary pays for November), so it is named
 * after the month the period starts in. None for plain calendar months.
 */
function salaryMonth(data: MonthSummary, lang: Lang): string | null {
  const start = data.from.slice(0, 7);
  if (start === data.month) return null;
  const name = monthLabel(start, lang).split(" ")[0];
  return lang === "pt" ? name.toLowerCase() : name;
}

export default function Budget() {
  const { t, lang } = useI18n();
  const { month, setMonth, refresh } = useApp();
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const { data, error, reload } = useLoad(() => api.get<MonthSummary>(`/summary?month=${month}`), [month]);

  const saved = () => {
    reload();
    refresh();
  };

  if (!data) return <Loading error={error} />;
  // Expenses split into their tables; a table with nothing planned or spent is hidden unless editing.
  const groups = EXPENSE_GROUPS.map(({ group, label }) => {
    const lines = data.expenses.filter((l) => l.group === group);
    return { group, label: t(label), lines, shown: lines.some((l) => (editing ? l.categoryId != null : l.plannedCents || l.actualCents)) };
  });
  const closedDone = () => {
    setClosing(null);
    saved();
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("budgetTitle")}</h1>
        {!data.close && (
          <button className="btn" onClick={() => setEditing((e) => !e)}>
            {editing ? t("donePlanned") : t("editPlanned")}
          </button>
        )}
      </header>
      <MonthNav month={month} onChange={setMonth} />
      <p className="muted small center period-line">
        {salaryMonth(data, lang) && <>{t("paidBySalary", { month: salaryMonth(data, lang)! })} · </>}
        {dateLabel(data.from, lang)} – {dateLabel(lastDay(data.to), lang)} · <Link to="/year">{t("seeYear")}</Link>
      </p>

      {data.previousOpen && (
        <p className="notice close-prompt">
          <span>{t("previousOpen", { month: monthName(data.previousOpen, lang) })}</span>
          <button className="btn small-btn primary" onClick={() => setClosing(data.previousOpen)}>
            {t("closeMonthButton", { month: monthName(data.previousOpen, lang) })}
          </button>
        </p>
      )}
      {data.canClose && (
        <p className="notice close-prompt">
          <span>{t("monthEnded")}</span>
          <button className="btn small-btn primary" onClick={() => setClosing(month)}>
            {t("closeMonthButton", { month: monthName(month, lang) })}
          </button>
        </p>
      )}
      {data.close && <Closed data={data} close={data.close} onReopened={saved} />}
      {closing && <CloseMonth month={closing} onClose={() => setClosing(null)} onDone={closedDone} />}

      {data.pending.length > 0 && <Pending data={data} onPaid={saved} />}
      {data.upcoming.length > 0 && <Upcoming data={data} />}

      <Section title={t("incomes")}>
        <BudgetTable month={month} lines={data.income} editing={editing} income onSaved={saved} />
      </Section>

      {groups.map(
        (g) =>
          g.shown && (
            <Section key={g.group} title={g.label}>
              <BudgetTable month={month} lines={g.lines} editing={editing} pickAccount={g.group === "variable"} onSaved={saved} />
            </Section>
          ),
      )}

      <Section title={t("savingsGroup")}>
        <BudgetTable
          month={month}
          lines={[]}
          savings={{ key: "savings", name: t("savingsPots"), plannedCents: data.plannedSavingsCents, actualCents: data.savingsCents }}
          editing={editing}
          onSaved={saved}
        />
      </Section>
      {!editing && <p className="muted small budget-help">{t("leftToSpendHelp")}</p>}

      {data.repaid.length > 0 && <Repaid data={data} />}

      <MonthSums data={data} groups={groups} />
    </div>
  );
}
