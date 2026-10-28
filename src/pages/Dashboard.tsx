import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../App";
import { Icon } from "../icons";
import { useI18n, type Key } from "../i18n";
import { dateLabel, money, monthLabel } from "../format";
import { Loading, Money, MonthNav, Progress, Section, useLoad } from "../components";
import TransactionForm from "../TransactionForm";
import SpendingChart, { axisLabel, niceScale } from "../SpendingChart";
import type { Account, Overview, SavingsPot, SummaryLine, Tip } from "../../shared/types";

function TipItem({ tip }: { tip: Tip }) {
  const { t, lang } = useI18n();
  const m = (c: number) => money(c, lang);
  const key = tip.type.charAt(0).toUpperCase() + tip.type.slice(1);
  const vars = {
    name: tip.name,
    actual: m(tip.amountCents),
    amount: m(tip.amountCents),
    planned: m(tip.compareCents),
    usual: m(tip.compareCents),
    diff: m(tip.amountCents - tip.compareCents),
  };
  const icon = { bad: "!", warn: "↗", info: "i", good: "✓" }[tip.level];
  return (
    <li className={`tip ${tip.level}`}>
      <span className="tip-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <strong>{t(`tip${key}Title` as Key, vars)}</strong>
        <span className="muted small">{t(`tip${key}` as Key, vars)}</span>
      </div>
    </li>
  );
}

/** Actual against planned for every expense category in use. */
function CategoryBars({ lines }: { lines: SummaryLine[] }) {
  const { t } = useI18n();
  const shown = lines
    .filter((l) => l.actualCents > 0 || l.plannedCents > 0)
    .sort((a, b) => b.actualCents - a.actualCents || b.plannedCents - a.plannedCents);
  if (shown.length === 0) return <p className="muted">{t("nothingYet")}</p>;
  const max = Math.max(...shown.map((l) => Math.max(l.actualCents, l.plannedCents)));
  return (
    <>
      <ul className="bars">
        {shown.map((l) => {
          const over = l.actualCents > l.plannedCents;
          return (
            <li key={l.categoryId ?? "none"}>
              <div className="bar-label small">
                <span>{l.name || t("uncategorised")}</span>
                <span>
                  <Money cents={l.actualCents} />
                  {l.plannedCents > 0 && (
                    <span className="muted">
                      {" / "}
                      <Money cents={l.plannedCents} />
                    </span>
                  )}
                </span>
              </div>
              <div className="bar-track plan-track">
                <div className={`bar-fill ${over ? "over" : ""}`} style={{ width: `${(l.actualCents / max) * 100}%` }} />
                {l.plannedCents > 0 && (
                  <div className="plan-mark" style={{ left: `calc(${(l.plannedCents / max) * 100}% - 1px)` }} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="legend small">
        <span>
          <i className="dot income" /> {t("withinBudget")}
        </span>
        <span>
          <i className="dot over" /> {t("overBudget")}
        </span>
        <span>
          <i className="mark" /> {t("planned")}
        </span>
      </div>
    </>
  );
}

/** Income against expenses plus savings, with each month's result on top. */
function MonthsChart({ history }: { history: Overview["history"] }) {
  const { t, lang } = useI18n();
  const W = 340, H = 190, L = 40, R = 4, T = 18, B = 22;
  const { top, step } = niceScale(Math.max(...history.map((h) => Math.max(h.incomeCents, h.expenseCents + h.savingsCents))));
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const slot = (W - L - R) / history.length;
  const bw = slot * 0.3;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const bar = (x: number, v: number, cls: string) => {
    const h = Math.max(0, y(0) - y(v));
    const r = Math.min(4, h, bw / 2);
    return (
      <path
        className={cls}
        d={`M${x} ${y(0)} V${y(0) - h + r} q0 ${-r} ${r} ${-r} h${bw - 2 * r} q${r} 0 ${r} ${r} V${y(0)} Z`}
      />
    );
  };

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={t("lastMonths")}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid-line" />
            <text x={L - 6} y={y(v) + 3} textAnchor="end" className="axis-text">
              {axisLabel(v)}
            </text>
          </g>
        ))}
        {history.map((h, i) => {
          const x0 = L + i * slot + slot * 0.18;
          const out = h.expenseCents + h.savingsCents;
          const net = h.incomeCents - out;
          const empty = !h.incomeCents && !out;
          const label = monthLabel(h.month, lang, true).replace(/\s?\d{4}$/, "");
          return (
            <g key={h.month}>
              {bar(x0, h.incomeCents, "bar-income")}
              {bar(x0 + bw + 2, out, "bar-expense")}
              {!empty && (
                <text
                  x={x0 + bw + 1}
                  y={y(Math.max(h.incomeCents, out)) - 5}
                  textAnchor="middle"
                  className={`axis-text strong ${net < 0 ? "neg-text" : ""}`}
                >
                  {net > 0 ? "+" : ""}
                  {Math.round(net / 100)}
                </text>
              )}
              <text x={x0 + bw + 1} y={H - 6} textAnchor="middle" className={`axis-text ${i === history.length - 1 ? "strong" : ""}`}>
                {label}
              </text>
              <rect x={L + i * slot} y={T} width={slot} height={H - T - B} className="hit">
                <title>
                  {monthLabel(h.month, lang)}: {t("incomes")} {money(h.incomeCents, lang)}, {t("expensesAndSavings")}{" "}
                  {money(out, lang)}, {t("balance")} {money(net, lang)}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
      <figcaption className="legend small">
        <span>
          <i className="dot income" /> {t("incomes")}
        </span>
        <span>
          <i className="dot expense" /> {t("expensesAndSavings")}
        </span>
      </figcaption>
    </figure>
  );
}

function PotRing({ pot }: { pot: SavingsPot }) {
  const { t } = useI18n();
  const pct = pot.goalCents > 0 ? Math.max(0, Math.min(1, pot.balanceCents / pot.goalCents)) : 0;
  const C = 2 * Math.PI * 17;
  return (
    <div className="pot-ring">
      <svg viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
        <circle cx="22" cy="22" r="17" className="ring-track" />
        {pct > 0 && (
          <circle cx="22" cy="22" r="17" className="ring-fill" strokeDasharray={`${pct * C} ${C}`} transform="rotate(-90 22 22)" />
        )}
        <text x="22" y="25.5" textAnchor="middle" className="ring-text">
          {pot.goalCents > 0 ? `${Math.round(pct * 100)}%` : "–"}
        </text>
      </svg>
      <div>
        <strong>{pot.name}</strong>
        <span className="muted small">
          <Money cents={pot.balanceCents} />
          {pot.goalCents > 0 ? (
            <>
              {" / "}
              <Money cents={pot.goalCents} />
            </>
          ) : (
            ` · ${t("noGoal")}`
          )}
        </span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { t, lang } = useI18n();
  const { month, setMonth } = useApp();
  const [adding, setAdding] = useState(false);
  const { data, error, reload } = useLoad(
    () =>
      Promise.all([api.get<Overview>(`/overview?month=${month}`), api.get<Account[]>("/accounts")]).then(
        ([overview, accounts]) => ({ ...overview, accounts }),
      ),
    [month],
  );

  if (!data) return <Loading error={error} />;

  const s = data.summary;
  const end = new Date(`${s.to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  const inProgress = data.elapsedDays > 0 && data.elapsedDays < data.days;
  const spentPct = s.plannedExpenseCents > 0 ? Math.round((s.totalExpenseCents / s.plannedExpenseCents) * 100) : 0;
  const elapsedPct = Math.round((data.elapsedDays / data.days) * 100);
  const projected = data.projectedExpenseCents;
  const projectedOver = projected != null && s.plannedExpenseCents > 0 ? projected - s.plannedExpenseCents : 0;

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("navDashboard")}</h1>
        <button className="btn primary fab" aria-label={t("addEntry")} onClick={() => setAdding(true)}>
          <Icon name="plus" size={20} />
          <span className="fab-label">{t("addEntry")}</span>
        </button>
      </header>
      <MonthNav month={month} onChange={setMonth} />
      <p className="muted center small">
        {t("period", { from: dateLabel(s.from, lang), to: dateLabel(end.toISOString().slice(0, 10), lang) })}
      </p>

      <div className="hero card accent">
        <div className="card-head">
          <span className="muted">{t("monthBalance")}</span>
          {inProgress && <span className="muted small">{t("dayOfMonth", { day: data.elapsedDays, days: data.days })}</span>}
        </div>
        <div className={`hero-value ${s.balanceCents < 0 ? "neg" : "pos"}`}>{money(s.balanceCents, lang)}</div>
        {s.pendingCents > 0 && (
          <Link to="/budget" className="muted small">
            {t("afterPending")}: {money(s.balanceCents - s.pendingCents, lang)}
          </Link>
        )}
        {s.plannedExpenseCents > 0 && (
          <>
            <div className="pace" role="presentation">
              <div className={`pace-fill ${spentPct > 100 ? "over" : ""}`} style={{ width: `${Math.min(100, spentPct)}%` }} />
              {inProgress && <div className="pace-today" style={{ left: `${elapsedPct}%` }} />}
            </div>
            <div className="bar-label small">
              <span>
                {t("spentPace", {
                  spent: money(s.totalExpenseCents, lang),
                  planned: money(s.plannedExpenseCents, lang),
                  pct: spentPct,
                })}
              </span>
              {inProgress && <span className="muted">{t("monthElapsed", { pct: elapsedPct })}</span>}
            </div>
          </>
        )}
        {projected != null && (
          <p className="muted small projection">
            {projectedOver > 0
              ? t("projectionOver", { amount: money(projected, lang), over: money(projectedOver, lang) })
              : t("projection", { amount: money(projected, lang) })}
          </p>
        )}
      </div>

      <div className="tiles">
        <div className="card tile">
          <span className="muted">{t("incomes")}</span>
          <strong className="num">{money(s.totalIncomeCents, lang)}</strong>
          <Progress actual={s.totalIncomeCents} planned={s.plannedIncomeCents} inverse />
          <span className="muted small">{t("receivedOfPlanned", { planned: money(s.plannedIncomeCents, lang) })}</span>
        </div>
        <div className="card tile">
          <span className="muted">{t("expenses")}</span>
          <strong className="num">{money(s.totalExpenseCents, lang)}</strong>
          <Progress actual={s.totalExpenseCents} planned={s.plannedExpenseCents} />
          <span className="muted small">{t("spentOfPlanned", { planned: money(s.plannedExpenseCents, lang) })}</span>
        </div>
        <div className="card tile">
          <span className="muted">{t("savedThisMonth")}</span>
          <strong className="num">{money(s.savingsCents, lang)}</strong>
          <Progress actual={s.savingsCents} planned={s.plannedSavingsCents} inverse />
          <span className="muted small">
            {t("totalSavings")}: {money(s.savingsTotalCents, lang)}
          </span>
        </div>
      </div>

      {(data.debts.people.length > 0 || data.debts.installmentsLeftCents > 0) && (
        <Section title={t("debtsTitle")} action={<Link to="/loans" className="link">{t("navLoans")} →</Link>}>
          <div className="person-balance">
            {data.debts.iOweCents > 0 && (
              <div>
                <span className="muted small">{t("iOwe")}</span>
                <strong className="num neg">{money(data.debts.iOweCents, lang)}</strong>
              </div>
            )}
            {data.debts.owedToMeCents > 0 && (
              <div>
                <span className="muted small">{t("owedToMe")}</span>
                <strong className="num pos">{money(data.debts.owedToMeCents, lang)}</strong>
              </div>
            )}
          </div>
          <ul className="list">
            {data.debts.people.map((p) => (
              <li key={p.person} className="list-row static">
                <span>
                  {p.person} <span className="muted small">· {p.netCents < 0 ? t("iOwe") : t("owedToMe")}</span>
                </span>
                <Money cents={p.netCents} signed />
              </li>
            ))}
            {data.debts.installmentsLeftCents > 0 && (
              <li className="list-row static">
                <span>{t("installmentPurchases")}</span>
                <Money cents={-data.debts.installmentsLeftCents} signed />
              </li>
            )}
          </ul>
        </Section>
      )}

      {data.accounts.length > 1 && (
        <Section title={t("accounts")} action={<Link to="/accounts" className="link">{t("navAccounts")} →</Link>}>
          <ul className="list">
            {data.accounts
              .filter((a) => !a.archived || a.balanceCents !== 0)
              .map((a) => (
                <li key={a.id} className="list-row static">
                  <span>{a.name}</span>
                  <Money cents={a.balanceCents} signed={a.balanceCents < 0} />
                </li>
              ))}
            <li className="list-row static">
              <strong>{t("totalAccounts")}</strong>
              <strong>
                <Money cents={data.accounts.reduce((x, a) => x + a.balanceCents, 0)} />
              </strong>
            </li>
          </ul>
        </Section>
      )}

      {data.elapsedDays > 0 && (
        <Section title={t("tips")}>
          {data.tips.length === 0 ? (
            <p className="muted">{t("noTips")}</p>
          ) : (
            <ul className="tips">
              {data.tips.map((tip, i) => (
                <TipItem key={i} tip={tip} />
              ))}
            </ul>
          )}
        </Section>
      )}

      {data.elapsedDays > 0 && (
        <Section title={t("spendingOverMonth")}>
          <SpendingChart data={data} />
        </Section>
      )}

      <Section title={t("categoriesChart")} action={<Link to="/budget" className="link">{t("navBudget")} →</Link>}>
        <CategoryBars lines={s.expenses} />
      </Section>

      <Section title={t("lastMonths")} action={<Link to="/balance" className="link">{t("navBalance")} →</Link>}>
        <MonthsChart history={data.history} />
      </Section>

      {data.pots.length > 0 && (
        <Section
          title={t("pots")}
          action={<Link to="/savings" className="link">{t("navSavings")} →</Link>}
        >
          <div className="pot-grid">
            {data.pots.map((p) => (
              <PotRing key={p.id} pot={p} />
            ))}
          </div>
        </Section>
      )}

      {adding && <TransactionForm onClose={() => setAdding(false)} onSaved={reload} />}
    </div>
  );
}
