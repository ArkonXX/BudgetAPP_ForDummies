import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../App";
import { useI18n } from "../i18n";
import { monthLabel } from "../format";
import { addMonths } from "../../shared/period";
import { Icon } from "../icons";
import { EXPENSE_GROUPS, Loading, Money, PlannedInput, Section, useLoad } from "../components";
import type { PlanGrid, PlanRow } from "../../shared/types";

/**
 * The spreadsheet's planning sheet: categories down in blocks (income, each
 * group of expenses, savings and money paid back), each with its total,
 * budget months across, and what is left at the end of each month. Past months show what really
 * happened; the current and later months show the plan, or more when more
 * is already spent or due.
 */
function PlanGridTable({
  grid,
  selected,
  onSelect,
  editing,
  onSaved,
}: {
  grid: PlanGrid;
  selected: string;
  onSelect: (m: string) => void;
  editing: boolean;
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const { settings } = useApp();
  // Budget months start on payday, so each is paid by the previous month's salary (M+1).
  const showSalaryMonth = !(settings.monthStartMode === "fixedDay" && settings.monthStartDay === 1);
  const wrap = useRef<HTMLDivElement>(null);
  const counted = (r: PlanRow, i: number) => {
    const c = r.cells[i];
    if (grid.months[i].status === "past") return c.actualCents;
    return Math.max(c.plannedCents, c.actualCents + c.toPayCents);
  };
  const editable = (r: PlanRow) => r.kind === "savings" || (r.categoryId != null && r.kind !== "repaid");
  const shown = (r: PlanRow) => (editing ? editable(r) : grid.months.some((_, i) => counted(r, i)));
  const blocks = [
    { key: "income", label: t("incomes"), all: grid.rows.filter((r) => r.kind === "income") },
    ...EXPENSE_GROUPS.map((g) => ({
      key: g.group,
      label: t(g.label),
      all: grid.rows.filter((r) => r.kind === "expense" && r.group === g.group),
    })),
    { key: "savings", label: t("savingsGroup"), all: grid.rows.filter((r) => r.kind === "savings" || r.kind === "repaid") },
  ]
    .map((b) => ({ ...b, rows: b.all.filter(shown) }))
    .filter((b) => b.rows.length > 0);
  const cols = grid.months.length;
  const total = (rows: PlanRow[], i: number) => rows.reduce((a, r) => a + counted(r, i), 0);
  const name = (r: PlanRow) =>
    r.kind === "savings" ? t("savingsLine") : r.kind === "repaid" ? t("repaidTo", { person: r.name }) : r.name || t("uncategorised");

  // Bring the chosen month into view on phones.
  useEffect(() => {
    const el = wrap.current;
    const th = el?.querySelector<HTMLElement>("th.selected");
    if (el && th) el.scrollLeft = th.offsetLeft - el.clientWidth / 2 + th.offsetWidth / 2;
  }, [selected, grid]);

  return (
    <div className="table-wrap plan-grid-wrap" ref={wrap}>
      <table className="plan-grid-table">
        <thead>
          <tr>
            <th className="sticky">{t("category")}</th>
            {grid.months.map((m) => (
              <th
                key={m.month}
                className={`num clickable${m.month === selected ? " selected" : ""}${m.endCents < 0 ? " short" : ""}`}
                onClick={() => onSelect(m.month)}
              >
                {monthLabel(m.month, lang, true)}
              </th>
            ))}
          </tr>
          {showSalaryMonth && (
            <tr className="salary-month-row">
              <th className="sticky">{t("salaryOf")}</th>
              {grid.months.map((m) => (
                <th key={m.month} className="num">
                  {monthLabel(addMonths(m.month, -1), lang, true)}
                </th>
              ))}
            </tr>
          )}
        </thead>
        {blocks.map((b) => (
          <tbody key={b.key} className={b.key === "income" ? "income-block" : ""}>
            <tr className="group-row">
              <th className="sticky">{b.label}</th>
              <td colSpan={cols} />
            </tr>
            {b.rows.map((r) => (
              <tr key={r.key}>
                <td className="sticky">
                  <span className="budget-name">{name(r)}</span>
                </td>
                {r.cells.map((c, i) => {
                  const m = grid.months[i];
                  const value = counted(r, i);
                  const over = m.status !== "past" && r.kind === "expense" && value > c.plannedCents;
                  const cls = `num${m.endCents < 0 ? " short" : ""}${m.month === selected ? " selected" : ""}${over ? " to-pay" : ""}${c.custom ? " custom" : ""}`;
                  return (
                    <td key={m.month} className={cls}>
                      {editing && m.status !== "past" && editable(r) ? (
                        <PlannedInput month={m.month} categoryId={r.kind === "savings" ? null : r.categoryId} cents={c.plannedCents} onSaved={onSaved} />
                      ) : value ? (
                        <Money cents={value} />
                      ) : (
                        <span className="muted">–</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="subtotal-row">
              <td className="sticky">{t("total")}</td>
              {grid.months.map((m, i) => (
                <td key={m.month} className={`num${m.month === selected ? " selected" : ""}`}>
                  {total(b.all, i) ? <Money cents={total(b.all, i)} /> : <span className="muted">–</span>}
                </td>
              ))}
            </tr>
          </tbody>
        ))}
        <tfoot>
          <tr>
            <td className="sticky">{t("endOfMonth")}</td>
            {grid.months.map((m) => (
              <td key={m.month} className={`num${m.endCents < 0 ? " short" : ""}${m.month === selected ? " selected" : ""}`}>
                <Money cents={m.endCents} signed />
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function YearPlan() {
  const { t } = useI18n();
  const { month, setMonth, refresh } = useApp();
  const navigate = useNavigate();
  const [year, setYear] = useState(Number(month.slice(0, 4)));
  const [editing, setEditing] = useState(false);
  const { data, error, reload } = useLoad(() => api.get<PlanGrid>(`/plan-grid?from=${year}-01&count=12`), [year]);

  const saved = () => {
    reload();
    refresh();
  };
  const open = (m: string) => {
    setMonth(m);
    navigate("/budget");
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("yearPlanTitle")}</h1>
        <button className="btn" onClick={() => setEditing((e) => !e)}>
          {editing ? t("donePlanned") : t("editPlanned")}
        </button>
      </header>
      <div className="month-nav">
        <button className="icon-btn" aria-label={t("previousYear")} onClick={() => setYear((y) => y - 1)}>
          <Icon name="left" size={18} />
        </button>
        <strong>{year}</strong>
        <button className="icon-btn" aria-label={t("nextYear")} onClick={() => setYear((y) => y + 1)}>
          <Icon name="right" size={18} />
        </button>
      </div>
      {data ? (
        <Section title={t("planGridTitle", { year: String(year) })}>
          <PlanGridTable grid={data} selected={month} onSelect={open} editing={editing} onSaved={saved} />
          <p className="muted small plan-grid-help">{editing ? t("planGridEditHelp") : t("planGridHelp")}</p>
        </Section>
      ) : (
        <Loading error={error} />
      )}
    </div>
  );
}
