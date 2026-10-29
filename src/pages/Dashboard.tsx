import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../App";
import { Icon } from "../icons";
import { useI18n, type Key, type Lang } from "../i18n";
import { dateLabel, money, monthLabel } from "../format";
import { Loading, Money, MonthNav, Section, useLoad } from "../components";
import TransactionForm from "../TransactionForm";
import SpendingChart, { axisLabel, niceScale } from "../SpendingChart";
import type { Account, Overview, SummaryLine, Todo, TodoType } from "../../shared/types";

/** "outubro" / "October": a month's name the way it reads in a sentence. */
function nameOf(month: string, lang: Lang): string {
  const name = monthLabel(month, lang).split(" ")[0];
  return lang === "pt" ? name.toLowerCase() : name;
}

/** The big number on top: what is free to spend, or what a past or future month leaves over. */
function Hero({ data }: { data: Overview }) {
  const { t, lang } = useI18n();
  const m = (c: number) => money(c, lang);
  const s = data.summary;
  const a = data.available;
  const lastDay = new Date(`${s.to}T00:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);

  if (a) {
    const rows: [Key, number][] = [
      ["freeInAccounts", a.accountsCents],
      ["freeToPay", -a.toPayCents],
      ["freeFixed", -a.fixedLeftCents],
      ["freeSavings", -a.savingsLeftCents],
    ];
    return (
      <div className="hero card accent">
        <span className="muted">
          {t("freeToSpend", {
            date: new Intl.DateTimeFormat(lang === "pt" ? "pt-PT" : "en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(lastDay),
          })}
        </span>
        <div className={`hero-value ${a.freeCents < 0 ? "neg" : "pos"}`}>{m(a.freeCents)}</div>
        <span className="muted small">
          {a.freeCents < 0
            ? t("noMoneyFree")
            : a.daysLeft > 1
              ? t("perDay", { amount: m(Math.floor(a.freeCents / a.daysLeft)), days: a.daysLeft })
              : t("perDayOne")}
        </span>
        {a.dayToDayLeftCents > 0 && (
          <span className="small">
            {a.dayToDayLeftCents > a.freeCents && a.freeCents >= 0
              ? t("dayToDayShort", { amount: m(a.dayToDayLeftCents), free: m(a.freeCents) })
              : t("dayToDayLeft", { amount: m(a.dayToDayLeftCents) })}
          </span>
        )}
        <details className="hero-details">
          <summary className="small">{t("howWorkedOut")}</summary>
          <ul className="sum-list small">
            {rows
              .filter(([, v], i) => i === 0 || v !== 0)
              .map(([k, v]) => (
                <li key={k}>
                  <span>{t(k)}</span>
                  <span className="num">{m(v)}</span>
                </li>
              ))}
            <li className="sum-total">
              <span>{t("freeResult")}</span>
              <span className="num">{m(a.freeCents)}</span>
            </li>
          </ul>
        </details>
      </div>
    );
  }

  const future = data.elapsedDays === 0;
  const result = future ? s.plannedIncomeCents - s.plannedExpenseCents - s.plannedSavingsCents : s.balanceCents;
  const figures = future
    ? { income: m(s.plannedIncomeCents), expense: m(s.plannedExpenseCents), saved: m(s.plannedSavingsCents) }
    : { income: m(s.totalIncomeCents), expense: m(s.totalExpenseCents + s.repaidCents), saved: m(s.savingsCents) };
  return (
    <div className="hero card accent">
      <span className="muted">
        {future ? t("plannedLeft") : t(result < 0 ? "shortInMonth" : "leftInMonth", { month: nameOf(s.month, lang) })}
      </span>
      <div className={`hero-value ${result < 0 ? "neg" : "pos"}`}>{m(result)}</div>
      <span className="muted small">{t("monthFigures", figures)}</span>
    </div>
  );
}

const TODO_LINKS: Record<TodoType, string> = {
  closeMonth: "/budget",
  uncategorised: "/budget?uncategorised=1",
  pending: "/budget",
  debitsSoon: "/budget",
  shortAccount: "/accounts",
  savingsBehind: "/savings",
  annualNext: "/plan",
};

function TodoItem({ item }: { item: Todo }) {
  const { t, lang } = useI18n();
  const m = (c: number) => money(c, lang);
  const vars = {
    name: item.type === "closeMonth" ? nameOf(item.name, lang) : item.name,
    month: item.type === "closeMonth" ? nameOf(item.name, lang) : "",
    count: item.count,
    amount: m(item.amountCents),
    actual: m(item.amountCents),
    planned: m(item.compareCents),
  };
  const [title, text]: [Key, Key] = {
    closeMonth: ["todoCloseMonthTitle", "todoCloseMonth"],
    uncategorised: [item.count === 1 ? "todoUncategorisedOneTitle" : "todoUncategorisedTitle", "todoUncategorised"],
    pending: [item.level === "bad" ? "todoPendingLateTitle" : "todoPendingTitle", "todoPending"],
    debitsSoon: item.count === 1 ? ["todoDebitsSoonOneTitle", "todoDebitsSoonOne"] : ["todoDebitsSoonTitle", "todoDebitsSoon"],
    shortAccount: ["todoShortAccountTitle", "todoShortAccount"],
    savingsBehind: ["tipSavingsBehindTitle", "tipSavingsBehind"],
    annualNext: ["tipAnnualNextTitle", "tipAnnualNext"],
  }[item.type] as [Key, Key];
  return (
    <li className={`tip ${item.level}`}>
      <span className="tip-icon" aria-hidden="true" />
      <Link to={TODO_LINKS[item.type]} className="todo-link">
        <strong>{t(title, vars)}</strong>
        <span className="muted small">{t(text, vars)}</span>
      </Link>
      <Icon name="right" size={16} />
    </li>
  );
}

type Watch = { line: SummaryLine; note: string; over: boolean; score: number };

/** The few categories that are over, close to their budget, unplanned or above the usual. */
function watchList(data: Overview, t: ReturnType<typeof useI18n>["t"], m: (c: number) => string): Watch[] {
  const usual = new Map(data.tips.filter((x) => x.type === "aboveUsual").map((x) => [x.name, x.compareCents]));
  const out: Watch[] = [];
  for (const l of data.summary.expenses) {
    if (l.categoryId == null) continue;
    const { plannedCents: planned, actualCents: actual, toPayCents: toPay } = l;
    if (planned > 0 && actual > planned)
      out.push({ line: l, over: true, score: 2 + (actual - planned) / planned, note: t("watchOver", { diff: m(actual - planned) }) });
    else if (planned > 0 && actual + toPay >= planned * 0.9) {
      const beyond = actual + toPay - planned;
      const note =
        beyond > 0
          ? t("watchToPayOver", { toPay: m(toPay), diff: m(beyond) })
          : toPay
            ? t("watchNearToPay", { toPay: m(toPay), left: m(-beyond) })
            : t("watchNear", { left: m(-beyond) });
      out.push({ line: l, over: beyond > 0, score: (actual + toPay) / planned, note });
    } else if (planned === 0 && actual >= 1000) out.push({ line: l, over: true, score: 1.5, note: t("watchUnplanned") });
    else if (usual.has(l.name)) out.push({ line: l, over: false, score: 0.5, note: t("watchAboveUsual", { usual: m(usual.get(l.name)!) }) });
  }
  return out.sort((a, b) => b.score - a.score);
}

function CategoryWatch({ data }: { data: Overview }) {
  const { t, lang } = useI18n();
  const m = (c: number) => money(c, lang);
  const all = watchList(data, t, m);
  const shown = all.slice(0, 3);
  if (shown.length === 0) return <p className="muted">{t("allCategoriesFine")}</p>;
  return (
    <ul className="bars">
      {shown.map(({ line: l, note, over }) => {
        const max = Math.max(l.actualCents + l.toPayCents, l.plannedCents, 1);
        return (
          <li key={l.categoryId}>
            <div className="bar-label small">
              <span>{l.name}</span>
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
              {l.plannedCents > 0 && <div className="plan-mark" style={{ left: `calc(${(l.plannedCents / max) * 100}% - 1px)` }} />}
            </div>
            <span className={`small ${over ? "neg" : "muted"}`}>{note}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** What each month left over once expenses and savings were paid, above or below zero. */
function LeftChart({ history }: { history: Overview["history"] }) {
  const { t, lang } = useI18n();
  const W = 340, H = 170, L = 40, R = 4, T = 16, B = 22;
  const nets = history.map((h) => h.incomeCents - h.expenseCents - h.savingsCents);
  const hi = Math.max(0, ...nets);
  const lo = Math.min(0, ...nets);
  const { top, step } = niceScale(Math.max(hi, -lo, 1));
  const bottom = lo < 0 ? -Math.ceil(-lo / step) * step : 0;
  const ceil = hi > 0 || lo === 0 ? top : 0;
  const y = (v: number) => T + ((ceil - v) / (ceil - bottom || 1)) * (H - T - B);
  const slot = (W - L - R) / history.length;
  const bw = slot * 0.5;
  const ticks: number[] = [];
  for (let v = bottom; v <= ceil; v += step) ticks.push(v);

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={t("leftPerMonth")}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className={v === 0 ? "zero-line" : "grid-line"} />
            <text x={L - 6} y={y(v) + 3} textAnchor="end" className="axis-text">
              {v < 0 ? `-${axisLabel(-v)}` : axisLabel(v)}
            </text>
          </g>
        ))}
        {history.map((h, i) => {
          const net = nets[i];
          const x = L + i * slot + (slot - bw) / 2;
          const empty = !h.incomeCents && !h.expenseCents && !h.savingsCents;
          const y0 = y(0), y1 = y(net);
          const label = monthLabel(h.month, lang, true).replace(/\s?\d{4}$/, "");
          return (
            <g key={h.month}>
              {!empty && (
                <rect x={x} width={bw} y={Math.min(y0, y1)} height={Math.max(1, Math.abs(y1 - y0))} rx={3} className={net < 0 ? "bar-neg" : "bar-income"} />
              )}
              {!empty && (
                <text x={x + bw / 2} y={net < 0 ? y1 + 12 : y1 - 5} textAnchor="middle" className={`axis-text strong ${net < 0 ? "neg-text" : ""}`}>
                  {net > 0 ? "+" : ""}
                  {Math.round(net / 100)}
                </text>
              )}
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" className={`axis-text ${i === history.length - 1 ? "strong" : ""}`}>
                {label}
              </text>
              <rect x={L + i * slot} y={T} width={slot} height={H - T - B} className="hit">
                <title>
                  {monthLabel(h.month, lang)}: {t("incomes")} {money(h.incomeCents, lang)}, {t("expenses")} {money(h.expenseCents, lang)},{" "}
                  {t("navSavings")} {money(h.savingsCents, lang)} = {money(net, lang)}
                </title>
              </rect>
            </g>
          );
        })}
      </svg>
      <figcaption className="muted small">{t("leftAfterSaving")}</figcaption>
    </figure>
  );
}

function NetWorthCard({ data }: { data: Overview & { accounts: Account[] } }) {
  const { t, lang } = useI18n();
  const n = data.netWorth;
  const accounts = data.accounts.filter((a) => !a.archived || a.balanceCents !== 0);
  const rows: { key: Key; cents: number; to: string }[] = [
    { key: "potsTotal", cents: n.potsCents, to: "/savings" },
    { key: "owedToMeTotal", cents: n.owedToMeCents, to: "/loans" },
    { key: "iOweTotal", cents: -n.iOweCents, to: "/loans" },
    { key: "installmentsTotal", cents: -n.installmentsLeftCents, to: "/loans" },
  ];
  return (
    <Section title={t("netWorth")}>
      <strong className={`networth-value num ${n.totalCents < 0 ? "neg" : ""}`}>{money(n.totalCents, lang)}</strong>
      <ul className="list">
        {accounts.map((a) => (
          <li key={a.id}>
            <Link to="/accounts" className="list-row">
              <span>{accounts.length > 1 ? a.name : t("totalAccounts")}</span>
              <Money cents={a.balanceCents} signed={a.balanceCents < 0} />
            </Link>
          </li>
        ))}
        {rows
          .filter((r) => r.cents !== 0 || r.key === "potsTotal")
          .map((r) => (
            <li key={r.key}>
              <Link to={r.to} className="list-row">
                <span>{t(r.key)}</span>
                <Money cents={r.cents} signed={r.cents < 0} />
              </Link>
            </li>
          ))}
      </ul>
      <p className="muted small">{t("netWorthHelp")}</p>
    </Section>
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

      <Hero data={data} />

      {(data.todo.length > 0 || data.available) && (
        <Section title={t("toDo")}>
          {data.todo.length === 0 ? (
            <p className="muted">{t("allDone")}</p>
          ) : (
            <ul className="tips todo">
              {data.todo.map((item, i) => (
                <TodoItem key={i} item={item} />
              ))}
            </ul>
          )}
        </Section>
      )}

      <div className="overview-grid">
        {data.elapsedDays > 0 && (
          <Section title={t(inProgress ? "monthPace" : "monthPacePast")}>
            {s.plannedExpenseCents > 0 && (
              <div>
                <div className="pace" role="presentation">
                  <div className={`pace-fill ${spentPct > 100 ? "over" : ""}`} style={{ width: `${Math.min(100, spentPct)}%` }} />
                  {inProgress && <div className="pace-today" style={{ left: `${elapsedPct}%` }} />}
                </div>
                <div className="bar-label small pace-label">
                  <span>
                    {t("spentPace", { spent: money(s.totalExpenseCents, lang), planned: money(s.plannedExpenseCents, lang), pct: spentPct })}
                  </span>
                  {inProgress && <span className="muted">{t("monthElapsed", { pct: elapsedPct })}</span>}
                </div>
              </div>
            )}
            {projected != null && (
              <p className="muted small projection">
                {projectedOver > 0
                  ? t("projectionOver", { amount: money(projected, lang), over: money(projectedOver, lang) })
                  : t("projection", { amount: money(projected, lang) })}
              </p>
            )}
            <SpendingChart data={data} />
          </Section>
        )}

        {data.elapsedDays > 0 && (
          <Section title={t("categoriesWatch")} action={<Link to="/budget" className="link">{t("seeAll")} →</Link>}>
            <CategoryWatch data={data} />
          </Section>
        )}

        <Section title={t("leftPerMonth")} action={<Link to="/balance" className="link">{t("navBalance")} →</Link>}>
          <LeftChart history={data.history} />
        </Section>

        <NetWorthCard data={data} />
      </div>

      {adding && <TransactionForm onClose={() => setAdding(false)} onSaved={reload} />}
    </div>
  );
}
