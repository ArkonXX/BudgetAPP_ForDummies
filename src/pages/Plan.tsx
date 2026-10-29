import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../App";
import { useI18n, type Key } from "../i18n";
import { money, monthName } from "../format";
import { Loading, Modal, Money, MoneyField, Progress, Section, useLoad } from "../components";
import type { BabyStep, BabyStepSettings, Loan, PlanItem, PlanSection, Settings } from "../../shared/types";

type Data = { settings: Settings; items: PlanItem[]; loans: Loan[]; babySteps: BabyStep[]; babyStepSettings: BabyStepSettings };

const MONTHLY_SECTIONS: PlanSection[] = ["fixed", "subscription", "investment", "donation"];

function ItemForm({ item, section, onClose, onSaved }: { item?: PlanItem; section: PlanSection; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const { categories, accounts } = useApp();
  const [name, setName] = useState(item?.name ?? "");
  const [amount, setAmount] = useState<number | null>(item?.amountCents ?? null);
  const [month, setMonth] = useState<number | null>(item?.month ?? (section === "annual" ? 1 : null));
  const [debitDay, setDebitDay] = useState<number | null>(item?.debitDay ?? null);
  // Empty means "Subscrições" (created on the first debit) for subscriptions, its own line
  // on the Budget for the rest, and the default account.
  const subsCategory = categories.find((c) => c.kind === "expense" && c.name.toLowerCase() === "subscrições");
  const [categoryId, setCategoryId] = useState<number | null>(
    item ? (item.categoryId ?? (section === "subscription" ? (subsCategory?.id ?? null) : null)) : section === "subscription" ? (subsCategory?.id ?? null) : null,
  );
  const [accountId, setAccountId] = useState<number | null>(item?.accountId ?? null);
  const [error, setError] = useState<string | null>(null);
  const expenseCategories = categories.filter((c) => c.kind === "expense" && (!c.archived || c.id === categoryId));
  const accountOptions = accounts.filter((a) => !a.archived || a.id === accountId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (amount == null || amount < 0) {
      setError(t("invalidAmount"));
      return;
    }
    const debit = section === "subscription" ? { debitDay } : {};
    await api.post("/plan/items", { id: item?.id, section, name, amountCents: amount, month, sort: item?.sort ?? 99, accountId, categoryId, ...debit });
    onSaved();
    onClose();
  };
  const remove = async () => {
    if (!item || !confirm(t("confirmDelete"))) return;
    await api.del(`/plan/items/${item.id}`);
    onSaved();
    onClose();
  };
  return (
    <Modal title={item ? item.name : `${t("newItem")} · ${t(section as Key)}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("name")}</span>
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!item} />
        </label>
        <MoneyField label={section === "annual" ? t("amount") : `${t("amount")} (${t("monthly").toLowerCase()})`} cents={amount} onChange={setAmount} />
        {section === "annual" && (
          <label className="field">
            <span>{t("paidIn")}</span>
            <select value={month ?? ""} onChange={(e) => setMonth(e.target.value ? Number(e.target.value) : null)}>
              <option value="">–</option>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {monthName(i + 1, lang)}
                </option>
              ))}
            </select>
          </label>
        )}
        {section === "subscription" && (
          <>
            <label className="field">
              <span>{t("debitDay")}</span>
              <select value={debitDay ?? ""} onChange={(e) => setDebitDay(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{t("debitDayNone")}</option>
                {Array.from({ length: 31 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
              <small className="muted">{t("debitDayHint")}</small>
            </label>
          </>
        )}
        <label className="field">
          <span>{t("planCategory")}</span>
          <select value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : null)}>
            {section === "subscription" ? !subsCategory && <option value="">{t("subscription")}</option> : <option value="">{t("planOwnLine")}</option>}
            {expenseCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <small className="muted">{t("planCategoryHelp")}</small>
        </label>
        {accountOptions.length > 1 && (
          <label className="field">
            <span>{t("paidFrom")}</span>
            <select
              value={accountId ?? accountOptions.find((a) => a.isDefault)?.id ?? ""}
              onChange={(e) => setAccountId(Number(e.target.value))}
            >
              {accountOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <small className="muted">{t("paidFromHelp")}</small>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          {item && (
            <button type="button" className="btn danger" onClick={remove}>
              {t("delete")}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn primary">{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Plan() {
  const { t, lang } = useI18n();
  const { refresh, accounts, categories } = useApp();
  const accountName = (id: number | null) =>
    accounts.length > 1 ? (accounts.find((a) => (id == null ? a.isDefault : a.id === id))?.name ?? "") : "";
  const { data, error, reload } = useLoad(() => api.get<Data>("/plan"), []);
  const [itemForm, setItemForm] = useState<{ section: PlanSection; item?: PlanItem } | null>(null);
  const [salaryEdit, setSalaryEdit] = useState<number | null | undefined>(undefined);

  if (!data) return <Loading error={error} />;

  const sum = (s: PlanSection) => data.items.filter((i) => i.section === s).reduce((a, i) => a + i.amountCents, 0);
  const loansMonthly = data.loans.filter((l) => !l.paidOff).reduce((a, l) => a + l.monthlyCents, 0);
  const salary = data.settings.salaryCents;
  const monthlyCommitments = MONTHLY_SECTIONS.reduce((a, s) => a + sum(s), 0) + loansMonthly;
  const yearlyCommitments = monthlyCommitments * 12 + sum("annual");

  const defaultAccountId = accounts.find((a) => a.isDefault)?.id;
  const setLoanAccount = async (id: number, accountId: number) => {
    await api.put(`/plan/loans/${id}/account`, { accountId: accountId === defaultAccountId ? null : accountId });
    reload();
  };
  const setLoanCategory = async (id: number, categoryId: number | null) => {
    await api.put(`/plan/loans/${id}/category`, { categoryId });
    reload();
  };
  const setLoanDebitDay = async (id: number, debitDay: number | null) => {
    await api.put(`/plan/loans/${id}/debit-day`, { debitDay });
    reload();
  };

  const saveSalary = async () => {
    if (salaryEdit == null) return;
    await api.put("/settings", { salaryCents: salaryEdit });
    setSalaryEdit(undefined);
    reload();
    refresh();
  };

  const cfg = data.babyStepSettings;
  const currentStep = data.babySteps.find((s) => s.status === "pending")?.step;
  const stepText = (s: BabyStep) =>
    t(`babyStep${s.step}` as Key, { amount: money(cfg.starterFundCents, lang), months: cfg.emergencyMonths, percent: cfg.investPercent });
  const stepDetail = (s: BabyStep) => {
    const p = s.progress;
    if (s.status === "na") return t("babyNa");
    if (!p) return null;
    if (p.unit === "count") return t(s.step === 6 ? "babyHousePaid" : "babyDebtsPaid", { paid: p.current, total: p.target });
    if (p.target === 0) return t(s.step === 3 ? "babyNoExpenses" : s.step === 4 ? "babyNoSalary" : "babyNoGoal");
    return `${money(p.current, lang)} / ${money(p.target, lang)}`;
  };

  const itemList = (section: PlanSection) => (
    <Section
      key={section}
      title={t(section as Key)}
      action={
        <button className="btn small-btn" onClick={() => setItemForm({ section })}>
          + {t("add")}
        </button>
      }
    >
      <div className="table-wrap">
      <table className="plan-table">
        <thead>
          <tr>
            <th />
            <th className="num">{section === "annual" ? t("paidIn") : t("monthly")}</th>
            <th className="num">{section === "annual" ? t("amount") : t("yearly")}</th>
          </tr>
        </thead>
        <tbody>
          {data.items
            .filter((i) => i.section === section)
            .map((i) => (
              <tr key={i.id} className="clickable" onClick={() => setItemForm({ section, item: i })}>
                <td>
                  {i.name}
                  {(i.debitDay != null || accountName(i.accountId)) && (
                    <span className="muted small">
                      {i.debitDay != null && ` · ${t("debitOn", { day: i.debitDay })}`}
                      {accountName(i.accountId) && ` · ${accountName(i.accountId)}`}
                    </span>
                  )}
                </td>
                <td className="num">{section === "annual" ? (i.month ? monthName(i.month, lang) : "–") : <Money cents={i.amountCents} />}</td>
                <td className="num">
                  <Money cents={section === "annual" ? i.amountCents : i.amountCents * 12} />
                </td>
              </tr>
            ))}
        </tbody>
        <tfoot>
          <tr>
            <td>{t("total")}</td>
            <td className="num">{section === "annual" ? "" : <Money cents={sum(section)} />}</td>
            <td className="num">
              <Money cents={section === "annual" ? sum(section) : sum(section) * 12} />
            </td>
          </tr>
        </tfoot>
      </table>
      </div>
    </Section>
  );

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("planTitle")}</h1>
      </header>

      <div className="card plan-summary">
        <div className="plan-summary-row">
          <span>{t("netSalary")}</span>
          {salaryEdit === undefined ? (
            <button className="link" onClick={() => setSalaryEdit(salary)}>
              <Money cents={salary} /> ✎
            </button>
          ) : (
            <span className="inline-edit">
              <MoneyField label="" cents={salaryEdit} onChange={setSalaryEdit} autoFocus />
              <button className="btn primary small-btn" onClick={saveSalary}>
                {t("save")}
              </button>
            </span>
          )}
        </div>
        <div className="plan-summary-grid">
          <span />
          <span className="muted small num">{t("monthly")}</span>
          <span className="muted small num">{t("yearly")}</span>
          <span>{t("leftAfterCommitments")}</span>
          <strong className={`num ${salary - monthlyCommitments < 0 ? "neg" : "pos"}`}>{money(salary - monthlyCommitments, lang)}</strong>
          <strong className={`num ${salary * 12 - yearlyCommitments < 0 ? "neg" : "pos"}`}>{money(salary * 12 - yearlyCommitments, lang)}</strong>
        </div>
      </div>

      <div className="plan-grid">
        {MONTHLY_SECTIONS.map(itemList)}
        {itemList("annual")}

        <Section title={t("loans")} action={<Link to="/loans" className="link">{t("navLoans")} →</Link>}>
          {data.loans.some((l) => !l.paidOff) && (
            <ul className="list plan-loans">
              {data.loans
                .filter((l) => !l.paidOff)
                .map((l) => (
                  <li key={l.id} className="plan-summary-row">
                    <span className="list-main">
                      <span>{l.name}</span>
                      {/* The account the monthly payment leaves from, for the payday transfer. */}
                      {accounts.length > 1 && (
                        <select
                          className="budget-account-select"
                          aria-label={t("paidFrom")}
                          value={l.accountId ?? defaultAccountId}
                          onChange={(e) => setLoanAccount(l.id, Number(e.target.value))}
                        >
                          {accounts
                            .filter((a) => !a.archived || a.id === l.accountId)
                            .map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                        </select>
                      )}
                      {/* The category it counts in on the Budget and Year plan. */}
                      <select
                        className="budget-account-select"
                        aria-label={t("planCategory")}
                        value={l.categoryId ?? ""}
                        onChange={(e) => setLoanCategory(l.id, e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">{t("planOwnLine")}</option>
                        {categories
                          .filter((c) => c.kind === "expense" && (!c.archived || c.id === l.categoryId))
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                      {/* The day it is debited, then added to Entries as a paid expense. */}
                      <select
                        className="budget-account-select"
                        aria-label={t("debitDay")}
                        title={t("loanDebitDayHint")}
                        value={l.debitDay ?? ""}
                        onChange={(e) => setLoanDebitDay(l.id, e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">{t("debitDayNone")}</option>
                        {Array.from({ length: 31 }, (_, i) => (
                          <option key={i + 1} value={i + 1}>
                            {t("debitOnDay", { day: i + 1 })}
                          </option>
                        ))}
                      </select>
                    </span>
                    <Money cents={l.monthlyCents} />
                  </li>
                ))}
            </ul>
          )}
          <div className="plan-summary-row">
            <span>{t("bankLoansMonthly")}</span>
            <Money cents={loansMonthly} />
          </div>
        </Section>

        <Section title={t("babySteps")} action={<Link to="/settings" className="link">{t("settingsTitle")} →</Link>}>
          <p className="muted small">{t("babyAuto")}</p>
          <ul className="steps">
            {data.babySteps.map((s) => (
              <li key={s.step} className={`step-${s.status} ${s.step === currentStep ? "step-current" : ""}`}>
                <span className="step-mark" aria-hidden="true">
                  {s.status === "done" ? "✓" : s.status === "na" ? "–" : s.step}
                </span>
                <div className="step-body">
                  <span className="step-text">{stepText(s)}</span>
                  {s.step === currentStep && <span className="pill">{t("babyCurrent")}</span>}
                  {s.status === "pending" && s.progress && s.progress.target > 0 && (
                    <Progress actual={Math.min(s.progress.current, s.progress.target)} planned={s.progress.target} />
                  )}
                  {stepDetail(s) && <span className="muted small">{stepDetail(s)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      </div>

      {itemForm && <ItemForm section={itemForm.section} item={itemForm.item} onClose={() => setItemForm(null)} onSaved={() => { reload(); refresh(); }} />}
    </div>
  );
}
