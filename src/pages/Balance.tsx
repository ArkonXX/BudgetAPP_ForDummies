import { api } from "../api";
import { useI18n } from "../i18n";
import { money, monthLabel } from "../format";
import { Loading, Money, Section, useLoad } from "../components";
import type { Account, BalanceReport, BalanceRow } from "../../shared/types";

/** Income vs expenses per month, newest on the right. */
function Chart({ rows }: { rows: BalanceRow[] }) {
  const { t, lang } = useI18n();
  const data = rows.slice(0, 12).reverse();
  const max = Math.max(1, ...data.map((r) => Math.max(r.incomeCents, r.expenseCents + r.savingsCents)));
  const w = 100 / Math.max(data.length, 1);
  return (
    <figure className="chart">
      <svg viewBox="0 0 100 50" preserveAspectRatio="none" role="img" aria-label={t("balanceTitle")}>
        {data.map((r, i) => {
          const hi = (r.incomeCents / max) * 46;
          const he = ((r.expenseCents + r.savingsCents) / max) * 46;
          const x = i * w + w * 0.15;
          const bw = w * 0.33;
          return (
            <g key={r.month}>
              <title>
                {monthLabel(r.month, lang)}: {t("incomes")} {money(r.incomeCents, lang)}, {t("expenses")}{" "}
                {money(r.expenseCents, lang)}
              </title>
              <rect x={x} y={50 - hi} width={bw} height={hi} rx={0.6} className="bar-income" />
              <rect x={x + bw + w * 0.04} y={50 - he} width={bw} height={he} rx={0.6} className="bar-expense" />
            </g>
          );
        })}
      </svg>
      <div className="chart-labels">
        {data.map((r) => (
          <span key={r.month}>{monthLabel(r.month, lang, true).replace(/\s?\d{4}$/, "")}</span>
        ))}
      </div>
      <figcaption className="legend small">
        <span>
          <i className="dot income" /> {t("incomes")}
        </span>
        <span>
          <i className="dot expense" /> {t("expenses")} + {t("saved").toLowerCase()}
        </span>
      </figcaption>
    </figure>
  );
}

export default function Balance() {
  const { t, lang } = useI18n();
  const { data, error } = useLoad(
    () => Promise.all([api.get<BalanceReport>("/balance"), api.get<Account[]>("/accounts")]),
    [],
  );
  if (!data) return <Loading error={error} />;
  const [report, accounts] = data;

  // The months only add up what was recorded, so gaps (months with no entries) would
  // make that sum drift from reality; the accounts' balances match the bank.
  const inAccounts = accounts.reduce((a, x) => a + x.balanceCents, 0);
  const recorded = report.months.reduce((a, m) => a + m.balanceCents, 0);
  const usedCats = report.categories.filter((c) => report.months.some((m) => m.byCategory[c.id]));
  const years = report.yearlyAverages.map((y) => y.year);

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("balanceTitle")}</h1>
      </header>
      <div className="card hero">
        <span className="muted">{t("totalAccounts")}</span>
        <div className={`hero-value ${inAccounts < 0 ? "neg" : "pos"}`}>{money(inAccounts, lang)}</div>
        <span className="muted small">
          {t("recordedResult")}: {money(recorded, lang)}
        </span>
      </div>

      {report.months.length > 0 && (
        <Section title={t("balanceTitle")}>
          <Chart rows={report.months} />
        </Section>
      )}

      <Section title={t("month")}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("month")}</th>
                <th className="num">{t("incomes")}</th>
                <th className="num">{t("expenses")}</th>
                <th className="num">{t("saved")}</th>
                <th className="num">{t("balance")}</th>
              </tr>
            </thead>
            <tbody>
              {report.months.map((m) => (
                <tr key={m.month}>
                  <td>{monthLabel(m.month, lang, true)}</td>
                  <td className="num">
                    <Money cents={m.incomeCents} />
                  </td>
                  <td className="num">
                    <Money cents={m.expenseCents} />
                  </td>
                  <td className="num">
                    <Money cents={m.savingsCents} />
                  </td>
                  <td className="num">
                    <Money cents={m.balanceCents} signed />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {usedCats.length > 0 && (
        <Section title={t("byCategory")}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="sticky">{t("category")}</th>
                  {report.months.map((m) => (
                    <th key={m.month} className="num">
                      {monthLabel(m.month, lang, true)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {usedCats.map((c) => (
                  <tr key={c.id}>
                    <td className="sticky">{c.name}</td>
                    {report.months.map((m) => (
                      <td key={m.month} className="num">
                        {m.byCategory[c.id] ? <Money cents={m.byCategory[c.id]} /> : <span className="muted">–</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {years.length > 0 && (
        <Section title={t("yearlyAverage")}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="sticky">{t("category")}</th>
                  {years.map((y) => (
                    <th key={y} className="num">
                      {y}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.categories
                  .filter((c) => report.yearlyAverages.some((y) => y.byCategory[c.id]))
                  .map((c) => (
                    <tr key={c.id}>
                      <td className="sticky">{c.name}</td>
                      {report.yearlyAverages.map((y) => (
                        <td key={y.year} className="num">
                          {y.byCategory[c.id] ? <Money cents={y.byCategory[c.id]} /> : <span className="muted">–</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}
