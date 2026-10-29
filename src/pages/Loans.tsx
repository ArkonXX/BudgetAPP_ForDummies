import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useApp } from "../App";
import { useI18n } from "../i18n";
import { dateLabel, money } from "../format";
import { Loading, Modal, Money, MoneyField, Progress, ScheduledHint, ScheduledTag, Section, useLoad } from "../components";
import { todayISO } from "../../shared/period";
import TransactionForm, { AccountField } from "../TransactionForm";
import type { InstallmentPlan, Loan, PersonalLoan, PersonalLoanDirection, PersonalLoanPayment } from "../../shared/types";

type Data = { loans: Loan[]; personal: PersonalLoan[]; installments: InstallmentPlan[] };

function LoanForm({ loan, onClose, onSaved }: { loan?: Loan; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { accounts } = useApp();
  const defaultAccount = accounts.find((a) => a.isDefault);
  const [name, setName] = useState(loan?.name ?? "");
  const [accountId, setAccountId] = useState<number | undefined>(loan?.accountId ?? defaultAccount?.id);
  const [principal, setPrincipal] = useState<number | null>(loan?.principalCents ?? null);
  const [monthly, setMonthly] = useState<number | null>(loan?.monthlyCents ?? 0);
  const [paidOff, setPaidOff] = useState(loan?.paidOff ?? false);
  const [mortgage, setMortgage] = useState(loan?.mortgage ?? false);
  const [debitDay, setDebitDay] = useState<number | null>(loan?.debitDay ?? null);
  const [amort, setAmort] = useState(loan?.amortizations.map((a) => ({ ...a, key: `${a.year}` })) ?? []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await api.post("/plan/loans", {
      id: loan?.id,
      name,
      principalCents: principal ?? 0,
      monthlyCents: monthly ?? 0,
      paidOff,
      mortgage,
      // The default account is stored as none, so it follows the main account if that changes.
      accountId: accountId === defaultAccount?.id ? null : accountId,
      debitDay,
      sort: loan?.sort ?? 99,
      amortizations: amort.filter((a) => a.year > 1900).map(({ year, amountCents }) => ({ year, amountCents })),
    });
    onSaved();
    onClose();
  };
  const remove = async () => {
    if (!loan || !confirm(t("confirmDelete"))) return;
    await api.del(`/plan/loans/${loan.id}`);
    onSaved();
    onClose();
  };
  const nextYear = () => (amort.length ? Math.max(...amort.map((a) => a.year)) + 1 : new Date().getFullYear());

  return (
    <Modal title={loan ? loan.name : t("newLoan")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("name")}</span>
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <MoneyField label={t("principal")} cents={principal} onChange={setPrincipal} />
        <MoneyField label={t("monthlyPayment")} cents={monthly} onChange={setMonthly} />
        {accounts.length > 1 && (
          <label className="field">
            <span>{t("paidFrom")}</span>
            <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
              {accounts
                .filter((a) => !a.archived || a.id === accountId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
        )}
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
          <small className="muted">{t("loanDebitDayHint")}</small>
        </label>
        <label className="check">
          <input type="checkbox" checked={paidOff} onChange={(e) => setPaidOff(e.target.checked)} />
          <span>{t("loanPaidOff")}</span>
        </label>
        <p className="muted small">{t("loanPaidOffHelp")}</p>
        <label className="check">
          <input type="checkbox" checked={mortgage} onChange={(e) => setMortgage(e.target.checked)} />
          <span>{t("loanMortgage")}</span>
        </label>
        <p className="muted small">{t("loanMortgageHelp")}</p>
        <fieldset className="fieldset">
          <legend>{t("amortizations")}</legend>
          {amort.map((a, i) => (
            <div className="row-2" key={a.key}>
              <label className="field">
                <span>{t("year")}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={a.year}
                  onChange={(e) => setAmort(amort.map((x, j) => (j === i ? { ...x, year: Number(e.target.value) } : x)))}
                />
              </label>
              <MoneyField
                label={t("amount")}
                cents={a.amountCents}
                onChange={(c) => setAmort(amort.map((x, j) => (j === i ? { ...x, amountCents: c ?? 0 } : x)))}
              />
            </div>
          ))}
          <button type="button" className="btn small-btn" onClick={() => setAmort([...amort, { year: nextYear(), amountCents: 0, key: `n${Date.now()}` }])}>
            + {t("addYear")}
          </button>
        </fieldset>
        <div className="form-actions">
          {loan && (
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

function PersonalLoanForm({
  loan,
  initial,
  onClose,
  onSaved,
}: {
  loan?: PersonalLoan;
  initial?: { person: string; direction: PersonalLoanDirection };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const [person, setPerson] = useState(loan?.person ?? initial?.person ?? "");
  const [direction, setDirection] = useState<PersonalLoanDirection>(loan?.direction ?? initial?.direction ?? "lent");
  const [amount, setAmount] = useState<number | null>(loan?.amountCents ?? null);
  const [date, setDate] = useState(loan?.date ?? todayISO());
  const [dueDate, setDueDate] = useState(loan?.dueDate ?? "");
  const [note, setNote] = useState(loan?.note ?? "");
  const { accounts } = useApp();
  const [accountId, setAccountId] = useState<number | null>(loan ? loan.accountId : (accounts.find((a) => a.isDefault)?.id ?? null));
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (amount == null || amount <= 0) {
      setError(t("invalidAmount"));
      return;
    }
    await api.post("/loans/personal", { id: loan?.id, person, direction, date, amountCents: amount, dueDate: dueDate || null, note, accountId });
    onSaved();
    onClose();
  };
  const remove = async () => {
    if (!loan || !confirm(t("confirmDelete"))) return;
    await api.del(`/loans/personal/${loan.id}`);
    onSaved();
    onClose();
  };

  return (
    <Modal title={loan ? loan.person : t("newPersonalLoan")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="segmented">
          <button type="button" className={direction === "lent" ? "active" : ""} onClick={() => setDirection("lent")}>
            {t("lent")}
          </button>
          <button type="button" className={direction === "borrowed" ? "active" : ""} onClick={() => setDirection("borrowed")}>
            {t("borrowed")}
          </button>
        </div>
        <p className="muted small">{direction === "lent" ? t("lentHelp") : t("borrowedHelp")}</p>
        <label className="field">
          <span>{t("person")}</span>
          <input required maxLength={80} value={person} onChange={(e) => setPerson(e.target.value)} autoFocus={!loan && !initial} />
        </label>
        <MoneyField label={t("amount")} cents={amount} onChange={setAmount} autoFocus={!loan && !!initial} />
        {!loan && <AccountField value={accountId} onChange={setAccountId} />}
        <label className="field">
          <span>{t("date")}</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <ScheduledHint date={date} />
        <label className="field">
          <span>{t("dueDate")}</span>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("note")}</span>
          <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {loan && loan.paidCents > 0 && (
          <p className="muted small">{t("paidOfTotal", { paid: money(loan.paidCents, lang), total: money(loan.amountCents, lang) })}</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          {loan && (
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

// Edits one payment that was recorded against a single loan.
function PaymentForm({
  loan,
  payment,
  onClose,
  onSaved,
}: {
  loan: PersonalLoan;
  payment: PersonalLoanPayment;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [amount, setAmount] = useState<number | null>(payment.amountCents);
  const [date, setDate] = useState(payment.date);
  const [note, setNote] = useState(payment.note);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (amount == null || amount <= 0) {
      setError(t("invalidAmount"));
      return;
    }
    await api.post("/loans/payments", { id: payment.id, loanId: loan.id, date, amountCents: amount, note });
    onSaved();
    onClose();
  };
  const remove = async () => {
    if (!confirm(t("confirmDelete"))) return;
    await api.del(`/loans/payments/${payment.id}`);
    onSaved();
    onClose();
  };

  return (
    <Modal title={`${t("payment")} · ${loan.person}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <MoneyField label={t("amount")} cents={amount} onChange={setAmount} />
        <label className="field">
          <span>{t("date")}</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <ScheduledHint date={date} />
        <label className="field">
          <span>{t("note")}</span>
          <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn danger" onClick={remove}>
            {t("delete")}
          </button>
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

// All personal loans with one person, shown together with a single balance.
interface PersonGroup {
  key: string;
  person: string;
  loans: PersonalLoan[];
  owedToMe: number;
  iOwe: number;
  open: boolean;
  overdue: boolean;
  lastDate: string;
}

function groupByPerson(loans: PersonalLoan[], today: string): PersonGroup[] {
  const groups = new Map<string, PersonGroup>();
  for (const l of loans) {
    const key = l.person.trim().toLocaleLowerCase("pt-PT");
    let g = groups.get(key);
    if (!g) {
      g = { key, person: l.person.trim(), loans: [], owedToMe: 0, iOwe: 0, open: false, overdue: false, lastDate: l.date };
      groups.set(key, g);
    }
    g.loans.push(l);
    if (l.direction === "lent") g.owedToMe += l.outstandingCents;
    else g.iOwe += l.outstandingCents;
    if (l.outstandingCents > 0) g.open = true;
    if (l.outstandingCents > 0 && l.dueDate != null && l.dueDate < today) g.overdue = true;
    if (l.date > g.lastDate) g.lastDate = l.date;
  }
  return [...groups.values()].sort((a, b) => b.lastDate.localeCompare(a.lastDate));
}

type HistoryEntry =
  | { kind: "loan"; date: string; loan: PersonalLoan }
  | { kind: "payment"; date: string; loan: PersonalLoan; parts: PersonalLoanPayment[]; amountCents: number; note: string };

function history(group: PersonGroup): HistoryEntry[] {
  const entries: HistoryEntry[] = group.loans.map((loan) => ({ kind: "loan", date: loan.date, loan }));
  const batches = new Map<string, Extract<HistoryEntry, { kind: "payment" }>>();
  for (const loan of group.loans) {
    for (const p of loan.payments) {
      const existing = p.batch ? batches.get(p.batch) : undefined;
      if (existing) {
        existing.parts.push(p);
        existing.amountCents += p.amountCents;
        continue;
      }
      const entry = { kind: "payment" as const, date: p.date, loan, parts: [p], amountCents: p.amountCents, note: p.note };
      if (p.batch) batches.set(p.batch, entry);
      entries.push(entry);
    }
  }
  // Newest first; on the same day the repayment comes after the loan it pays.
  return entries.sort((a, b) => b.date.localeCompare(a.date) || (a.kind === b.kind ? 0 : a.kind === "payment" ? -1 : 1));
}

function PersonPaymentForm({ group, onClose, onSaved }: { group: PersonGroup; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const both = group.owedToMe > 0 && group.iOwe > 0;
  const [direction, setDirection] = useState<PersonalLoanDirection>(group.iOwe > 0 ? "borrowed" : "lent");
  const owed = direction === "lent" ? group.owedToMe : group.iOwe;
  const [amount, setAmount] = useState<number | null>(owed);
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const { accounts } = useApp();
  const [accountId, setAccountId] = useState<number | null>(accounts.find((a) => a.isDefault)?.id ?? null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (amount == null || amount <= 0) {
      setError(t("invalidAmount"));
      return;
    }
    if (amount > owed) {
      setError(t("moreThanOwed"));
      return;
    }
    await api.post("/loans/personal/pay", { person: group.person, direction, date, amountCents: amount, note, accountId });
    onSaved();
    onClose();
  };

  return (
    <Modal title={`${t("addPayment")} · ${group.person}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {both && (
          <div className="segmented">
            <button type="button" className={direction === "borrowed" ? "active" : ""} onClick={() => setDirection("borrowed")}>
              {t("iPaidBack")}
            </button>
            <button type="button" className={direction === "lent" ? "active" : ""} onClick={() => setDirection("lent")}>
              {t("theyPaidBack")}
            </button>
          </div>
        )}
        <p className="muted small">{t("personPaymentHelp")}</p>
        <MoneyField key={direction} label={t("amount")} cents={amount} onChange={setAmount} autoFocus />
        <AccountField value={accountId} onChange={setAccountId} />
        <label className="field">
          <span>{t("date")}</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <ScheduledHint date={date} />
        <label className="field">
          <span>{t("note")}</span>
          <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
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

function PersonSheet({
  group,
  onClose,
  onSaved,
  onEditLoan,
  onNewLoan,
  onEditPayment,
  onPay,
}: {
  group: PersonGroup;
  onClose: () => void;
  onSaved: () => void;
  onEditLoan: (loan: PersonalLoan) => void;
  onNewLoan: (direction: PersonalLoanDirection) => void;
  onEditPayment: (loan: PersonalLoan, payment: PersonalLoanPayment) => void;
  onPay: () => void;
}) {
  const { t, lang } = useI18n();
  const today = todayISO();
  const removeBatch = async (batch: string) => {
    if (!confirm(t("confirmDelete"))) return;
    await api.del(`/loans/payment-batches/${batch}`);
    onSaved();
  };

  return (
    <Modal title={group.person} onClose={onClose}>
      <div className="form">
        <div className="person-balance">
          {group.iOwe > 0 && (
            <div>
              <span className="muted small">{t("iOwe")}</span>
              <strong className="num neg">{money(group.iOwe, lang)}</strong>
            </div>
          )}
          {group.owedToMe > 0 && (
            <div>
              <span className="muted small">{t("owedToMe")}</span>
              <strong className="num pos">{money(group.owedToMe, lang)}</strong>
            </div>
          )}
          {!group.open && <span className="pos">{t("allSettled")}</span>}
        </div>
        <div className="pot-actions">
          {group.open && (
            <button type="button" className="btn primary small-btn" onClick={onPay}>
              {t("addPayment")}
            </button>
          )}
          <button type="button" className="btn small-btn" onClick={() => onNewLoan(group.iOwe > 0 || group.owedToMe === 0 ? group.loans[0].direction : "lent")}>
            + {t("newLoanSamePerson")}
          </button>
        </div>
        <h3 className="sheet-subhead">{t("history")}</h3>
        <ul className="list">
          {history(group).map((h) =>
            h.kind === "loan" ? (
              <li key={`l${h.loan.id}`}>
                <button type="button" className="list-row" onClick={() => onEditLoan(h.loan)}>
                  <div className="list-main">
                    <strong>{h.loan.direction === "lent" ? t("lent") : t("borrowed")}</strong>
                    <span className="muted small">
                      {dateLabel(h.date, lang)}
                      {h.loan.note ? ` · ${h.loan.note}` : ""}
                      {h.loan.outstandingCents === 0 ? (
                        <span className="pos"> · {t("paidTag")}</span>
                      ) : h.loan.paidCents > 0 ? (
                        ` · ${t("outstanding")} ${money(h.loan.outstandingCents, lang)}`
                      ) : (
                        ""
                      )}
                      {h.loan.outstandingCents > 0 && h.loan.dueDate && h.loan.dueDate < today && <span className="neg"> · {t("overdue")}</span>}
                      {h.loan.scheduled && <ScheduledTag date={h.loan.date} />}
                    </span>
                  </div>
                  <Money cents={h.loan.direction === "lent" ? h.loan.amountCents : -h.loan.amountCents} signed />
                </button>
              </li>
            ) : (
              <li key={`p${h.parts[0].id}`}>
                <button
                  type="button"
                  className="list-row"
                  onClick={() => (h.parts.length > 1 ? removeBatch(h.parts[0].batch!) : onEditPayment(h.loan, h.parts[0]))}
                >
                  <div className="list-main">
                    <strong>{h.loan.direction === "lent" ? t("theyPaidBack") : t("iPaidBack")}</strong>
                    <span className="muted small">
                      {dateLabel(h.date, lang)}
                      {h.note ? ` · ${h.note}` : ""}
                      {h.parts.length > 1 ? ` · ${t("coversLoans", { n: h.parts.length })}` : ""}
                      {h.parts[0].scheduled && <ScheduledTag date={h.date} />}
                    </span>
                  </div>
                  <Money cents={h.loan.direction === "lent" ? -h.amountCents : h.amountCents} signed />
                </button>
              </li>
            ),
          )}
        </ul>
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// One purchase in installments: each installment with its date, marked paid from here.
function InstallmentSheet({ plan, onClose, onSaved }: { plan: InstallmentPlan; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState<number | null>(null);
  const today = todayISO();
  const pay = async (id: number) => {
    setBusy(id);
    try {
      await api.post(`/transactions/${id}/pay`, { date: today });
      onSaved();
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    if (!confirm(t("confirmDeletePurchase"))) return;
    await api.del(`/installments/${plan.id}`);
    onSaved();
    onClose();
  };
  return (
    <Modal title={plan.name} onClose={onClose}>
      <div className="form">
        <p className="muted small">
          {t("installmentPaidOfTotal", { paid: money(plan.paidCents, lang), total: money(plan.totalCents, lang) })}
        </p>
        <ul className="list">
          {plan.installments.map((i) => (
            <li key={i.id}>
              <div className="list-row">
                <div className="list-main">
                  <strong>
                    {i.installment!.seq}/{plan.count}
                  </strong>
                  <span className="muted small">
                    {dateLabel(i.date, lang)}
                    {i.paid ? (
                      <span className="pos"> · {t("paidTag")}</span>
                    ) : (
                      i.date < today && <span className="neg"> · {t("overdue")}</span>
                    )}
                  </span>
                </div>
                <span className="budget-nums">
                  <Money cents={i.amountCents} />
                  {!i.paid && (
                    <>
                      {" "}
                      <button className="btn small-btn" disabled={busy === i.id} onClick={() => pay(i.id)}>
                        {t("markPaid")}
                      </button>
                    </>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
        <p className="muted small">{t("installmentSheetHelp")}</p>
        <div className="form-actions">
          <button type="button" className="btn danger" onClick={remove}>
            {t("delete")}
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function Loans() {
  const { t, lang } = useI18n();
  const { data, error, reload } = useLoad(() => api.get<Data>("/loans"), []);
  const [loanForm, setLoanForm] = useState<Loan | "new" | null>(null);
  const [personalForm, setPersonalForm] = useState<
    { loan?: PersonalLoan; initial?: { person: string; direction: PersonalLoanDirection } } | null
  >(null);
  const [paymentForm, setPaymentForm] = useState<{ loan: PersonalLoan; payment: PersonalLoanPayment } | null>(null);
  const [personKey, setPersonKey] = useState<string | null>(null);
  const [payingKey, setPayingKey] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);
  const [newPurchase, setNewPurchase] = useState(false);
  const [planId, setPlanId] = useState<number | null>(null);
  const [showPaidPlans, setShowPaidPlans] = useState(false);

  if (!data) return <Loading error={error} />;

  const open = data.personal.filter((l) => l.outstandingCents > 0);
  const owedToMe = open.filter((l) => l.direction === "lent").reduce((a, l) => a + l.outstandingCents, 0);
  const iOwe = open.filter((l) => l.direction === "borrowed").reduce((a, l) => a + l.outstandingCents, 0);
  const bankMonthly = data.loans.filter((l) => !l.paidOff).reduce((a, l) => a + l.monthlyCents, 0);
  const today = todayISO();
  const people = groupByPerson(data.personal, today);
  const shown = people.filter((g) => g.open !== showSettled);
  const openPerson = people.find((g) => g.key === personKey);
  const payingPerson = people.find((g) => g.key === payingKey);
  const plansDue = data.installments.reduce((a, p) => a + p.remainingCents, 0);
  const plans = data.installments.filter((p) => (p.remainingCents > 0) !== showPaidPlans);
  const openPlan = data.installments.find((p) => p.id === planId);

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("loansTitle")}</h1>
        <button className="btn primary" onClick={() => setPersonalForm({})}>
          + {t("newPersonalLoan")}
        </button>
      </header>

      <div className="tiles">
        <div className="card tile">
          <span className="muted">{t("owedToMe")}</span>
          <strong className="num pos">{money(owedToMe, lang)}</strong>
        </div>
        <div className="card tile">
          <span className="muted">{t("iOwe")}</span>
          <strong className={`num ${iOwe > 0 ? "neg" : ""}`}>{money(iOwe, lang)}</strong>
        </div>
        <div className="card tile">
          <span className="muted">{t("bankLoansMonthly")}</span>
          <strong className="num">{money(bankMonthly, lang)}</strong>
        </div>
      </div>

      <Section
        title={t("personalLoans")}
        action={
          <div className="segmented">
            <button className={!showSettled ? "active" : ""} onClick={() => setShowSettled(false)}>
              {t("active")}
            </button>
            <button className={showSettled ? "active" : ""} onClick={() => setShowSettled(true)}>
              {t("settled")}
            </button>
          </div>
        }
      >
        {shown.length === 0 ? (
          <p className="muted">{t("nothingYet")}</p>
        ) : (
          <ul className="list">
            {shown.map((g) => {
              const net = g.owedToMe - g.iOwe;
              const total = g.loans.reduce((a, l) => a + l.amountCents, 0);
              const paid = g.loans.reduce((a, l) => a + l.paidCents, 0);
              const openCount = g.loans.filter((l) => l.outstandingCents > 0).length;
              return (
                <li key={g.key}>
                  <button className="list-row" onClick={() => setPersonKey(g.key)}>
                    <div className="list-main">
                      <strong>{g.person}</strong>
                      <span className="muted small">
                        {g.open
                          ? `${g.iOwe > 0 ? t("iOwe") : t("owedToMe")} · ${t("openLoans", { n: openCount })}`
                          : t("loanCount", { n: g.loans.length })}
                        {` · ${dateLabel(g.lastDate, lang)}`}
                        {g.overdue && <span className="neg"> · {t("overdue")}</span>}
                      </span>
                      <Progress actual={paid} planned={total} />
                      <span className="muted small">{t("paidOfTotal", { paid: money(paid, lang), total: money(total, lang) })}</span>
                    </div>
                    <Money cents={net} signed />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title={t("installmentPurchases")}
        action={
          <button className="btn small-btn" onClick={() => setNewPurchase(true)}>
            + {t("add")}
          </button>
        }
      >
        {plans.length === 0 ? (
          <p className="muted">{showPaidPlans ? t("nothingYet") : t("noInstallments")}</p>
        ) : (
          <ul className="list">
            {plans.map((p) => {
              const paidCount = p.installments.filter((i) => i.paid).length;
              const overdue = p.nextDue != null && p.nextDue < today;
              return (
                <li key={p.id}>
                  <button className="list-row" onClick={() => setPlanId(p.id)}>
                    <div className="list-main">
                      <strong>{p.name}</strong>
                      <span className="muted small">
                        {t("installmentsPaid", { paid: paidCount, count: p.count })}
                        {p.nextDue && ` · ${t("nextInstallment")} ${dateLabel(p.nextDue, lang)}`}
                        {overdue && <span className="neg"> · {t("overdue")}</span>}
                      </span>
                      <Progress actual={p.paidCents} planned={p.totalCents} />
                      <span className="muted small">
                        {t("installmentPaidOfTotal", { paid: money(p.paidCents, lang), total: money(p.totalCents, lang) })}
                      </span>
                    </div>
                    <Money cents={-p.remainingCents} signed />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="section-foot">
          <span className="muted small">
            {!showPaidPlans && plansDue > 0 && `${t("installmentsLeft")}: ${money(plansDue, lang)}`}
          </span>
          {data.installments.some((p) => p.remainingCents === 0) && (
            <button className="btn small-btn" onClick={() => setShowPaidPlans((v) => !v)}>
              {showPaidPlans ? t("showActivePurchases") : t("showPaidPurchases")}
            </button>
          )}
        </div>
      </Section>

      <Section
        title={t("loans")}
        action={
          <button className="btn small-btn" onClick={() => setLoanForm("new")}>
            + {t("add")}
          </button>
        }
      >
        <ul className="list">
          {data.loans.map((l) => {
            const amortized = l.amortizations.reduce((a, x) => a + x.amountCents, 0);
            return (
              <li key={l.id}>
                <button className="list-row" onClick={() => setLoanForm(l)}>
                  <div className="list-main">
                    <strong>
                      {l.name}
                      {l.mortgage && <span className="muted small"> · {t("loanMortgageTag")}</span>}
                      {l.paidOff && <span className="pos small"> · {t("loanPaidOffTag")}</span>}
                    </strong>
                    <span className="muted small">
                      {t("principal")}: {money(l.principalCents, lang)} · {t("monthlyPayment")}: {money(l.monthlyCents, lang)}
                      {l.debitDay != null && !l.paidOff && ` · ${t("debitOn", { day: l.debitDay })}`}
                    </span>
                    {l.amortizations.length > 0 && (
                      <span className="muted small">
                        {t("amortizations")}: {l.amortizations.map((a) => `${a.year} ${money(a.amountCents, lang)}`).join(" · ")}
                      </span>
                    )}
                  </div>
                  <Money cents={amortized} />
                </button>
              </li>
            );
          })}
        </ul>
        <p className="muted small">
          {t("totalAmortized")}: {money(data.loans.reduce((a, l) => a + l.amortizations.reduce((b, x) => b + x.amountCents, 0), 0), lang)}
        </p>
      </Section>

      {newPurchase && <TransactionForm installments onClose={() => setNewPurchase(false)} onSaved={reload} />}
      {openPlan && <InstallmentSheet plan={openPlan} onClose={() => setPlanId(null)} onSaved={reload} />}
      {loanForm && <LoanForm loan={loanForm === "new" ? undefined : loanForm} onClose={() => setLoanForm(null)} onSaved={reload} />}
      {openPerson && !personalForm && !paymentForm && !payingPerson && (
        <PersonSheet
          group={openPerson}
          onClose={() => setPersonKey(null)}
          onSaved={reload}
          onEditLoan={(loan) => setPersonalForm({ loan })}
          onNewLoan={(direction) => setPersonalForm({ initial: { person: openPerson.person, direction } })}
          onEditPayment={(loan, payment) => setPaymentForm({ loan, payment })}
          onPay={() => setPayingKey(openPerson.key)}
        />
      )}
      {personalForm && (
        <PersonalLoanForm
          loan={personalForm.loan}
          initial={personalForm.initial}
          onClose={() => setPersonalForm(null)}
          onSaved={reload}
        />
      )}
      {paymentForm && (
        <PaymentForm loan={paymentForm.loan} payment={paymentForm.payment} onClose={() => setPaymentForm(null)} onSaved={reload} />
      )}
      {payingPerson && <PersonPaymentForm group={payingPerson} onClose={() => setPayingKey(null)} onSaved={reload} />}
    </div>
  );
}
