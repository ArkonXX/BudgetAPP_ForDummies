import { useState, type FormEvent } from "react";
import { api } from "./api";
import { useApp } from "./App";
import { useI18n } from "./i18n";
import { dateLabel, money } from "./format";
import { Modal, MoneyField, useLoad } from "./components";
import { installmentDate, todayISO } from "../shared/period";
import type { Kind, PersonalLoan, Transaction } from "../shared/types";

// Spacing between installments: same day each month, or every N days.
const INTERVALS: { days: number | null; key: "everyMonth" | "every30Days" | "every14Days" }[] = [
  { days: null, key: "everyMonth" },
  { days: 30, key: "every30Days" },
  { days: 14, key: "every14Days" },
];

/** Account picker, shown only when there is more than one account. */
export function AccountField({ value, onChange }: { value: number | null; onChange: (id: number) => void }) {
  const { t } = useI18n();
  const { accounts } = useApp();
  const options = accounts.filter((a) => !a.archived || a.id === value);
  if (options.length < 2) return null;
  return (
    <label className="field">
      <span>{t("account")}</span>
      <select value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))}>
        {options.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );
}

// People in Loans with what is still owed each way, keyed by lowercase name.
type LoanPeople = Map<string, { name: string; lent: number; borrowed: number }>;

function loanPeople(loans: PersonalLoan[]): LoanPeople {
  const people: LoanPeople = new Map();
  for (const l of loans) {
    const key = l.person.trim().toLocaleLowerCase("pt-PT");
    const p = people.get(key) ?? { name: l.person.trim(), lent: 0, borrowed: 0 };
    p[l.direction] += l.outstandingCents;
    people.set(key, p);
  }
  return people;
}

/** The amounts of each installment: equal parts, the leftover cents on the last. */
function splitAmount(total: number, count: number): number[] {
  const each = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? total - each * (count - 1) : each));
}

export default function TransactionForm({
  initial,
  installments: startInInstallments = false,
  onClose,
  onSaved,
}: {
  initial?: Transaction;
  installments?: boolean; // open a new expense already split into installments
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const { categories, accounts } = useApp();
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "expense");
  const [date, setDate] = useState(initial?.date ?? todayISO());
  const [amount, setAmount] = useState<number | null>(initial?.amountCents ?? null);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [categoryId, setCategoryId] = useState<number | null>(initial?.categoryId ?? null);
  const [accountId, setAccountId] = useState<number | null>(
    initial?.accountId ?? accounts.find((a) => a.isDefault)?.id ?? null,
  );
  const [unpaid, setUnpaid] = useState(initial ? !initial.paid : false);
  // Only a new expense can be split; each installment is then edited on its own.
  const [split, setSplit] = useState(!initial && startInInstallments);
  const [count, setCount] = useState(3);
  const [everyDays, setEveryDays] = useState<number | null>(null);
  const [firstPaid, setFirstPaid] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A new entry can instead be a personal loan or a repayment ("l:new:<person>" / "l:repay:<person>"),
  // recorded in Loans against that account rather than as an expense or income.
  const people = [...loanPeople(useLoad(() => api.get<{ personal: PersonalLoan[] }>("/loans").then((r) => r.personal), []).data ?? []).values()];
  const [loan, setLoan] = useState("");
  const options = categories.filter((c) => c.kind === kind && (!c.archived || c.id === categoryId));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (amount == null || amount <= 0) {
      setError(t("invalidAmount"));
      return;
    }
    if (loan) {
      const [, mode, ...name] = loan.split(":");
      const person = name.join(":");
      const owed = people.find((p) => p.name === person)?.[kind === "expense" ? "borrowed" : "lent"] ?? 0;
      if (mode === "repay" && amount > owed) {
        setError(t("moreThanOwed"));
        return;
      }
      setBusy(true);
      try {
        if (mode === "repay")
          // Money out pays back what I borrowed; money in is them paying back what I lent.
          await api.post("/loans/personal/pay", {
            person,
            direction: kind === "expense" ? "borrowed" : "lent",
            date,
            amountCents: amount,
            note: description,
            accountId,
          });
        else
          await api.post("/loans/personal", {
            person,
            direction: kind === "expense" ? "lent" : "borrowed",
            date,
            amountCents: amount,
            dueDate: null,
            note: description,
            accountId,
          });
        onSaved();
        onClose();
      } catch {
        setError(t("error"));
      } finally {
        setBusy(false);
      }
      return;
    }
    const inInstallments = split && kind === "expense";
    if (inInstallments && (count < 2 || count > 48 || amount < count)) {
      setError(t("invalidInstallments"));
      return;
    }
    setBusy(true);
    try {
      const category = options.find((c) => c.id === categoryId);
      if (inInstallments) {
        await api.post("/installments", {
          name: description.trim() || category?.name || t("installmentPurchase"),
          totalCents: amount,
          count,
          everyDays,
          categoryId: category ? category.id : null,
          accountId,
          firstDate: date,
          firstPaid,
        });
        onSaved();
        onClose();
        return;
      }
      await api.post("/transactions", {
        id: initial?.id,
        kind,
        date,
        amountCents: amount,
        description,
        categoryId: options.some((c) => c.id === categoryId) ? categoryId : null,
        accountId,
        paid: kind === "income" || !unpaid,
      });
      onSaved();
      onClose();
    } catch {
      setError(t("error"));
    } finally {
      setBusy(false);
    }
  };

  // A paid installment can only go back to still to pay; an unpaid one is removed with its purchase.
  const installmentPaid = initial?.installment != null && initial.paid;
  const remove = async () => {
    if (!initial || !confirm(t(installmentPaid ? "confirmUndoPayment" : "confirmDelete"))) return;
    await api.del(`/transactions/${initial.id}`);
    onSaved();
    onClose();
  };

  return (
    <Modal title={initial ? t("editEntry") : t("newEntry")} onClose={onClose}>
      <form onSubmit={submit} className="form">
        <div className="segmented">
          {(["expense", "income"] as Kind[]).map((k) => (
            <button type="button" key={k} className={kind === k ? "active" : ""} onClick={() => setKind(k)}>
              {t(k)}
            </button>
          ))}
        </div>
        <MoneyField label={split && kind === "expense" ? t("totalAmount") : t("amount")} cents={amount} onChange={setAmount} autoFocus={!initial} />
        <label className="field">
          <span>{t("category")}</span>
          <select
            value={loan || (categoryId ?? "")}
            onChange={(e) => {
              const v = e.target.value;
              setLoan(v.startsWith("l:") ? v : "");
              setCategoryId(v && !v.startsWith("l:") ? Number(v) : null);
              if (v.startsWith("l:")) setSplit(false);
            }}
          >
            <option value="">{t("noCategory")}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {!initial && people.length > 0 && (
              <optgroup label={t("statementLoanGroup")}>
                {people.map((p) => (
                  <option key={`n${p.name}`} value={`l:new:${p.name}`}>
                    {t(kind === "income" ? "statementLoanFrom" : "statementLoanTo", { person: p.name })}
                  </option>
                ))}
                {people
                  .filter((p) => (kind === "expense" ? p.borrowed : p.lent) > 0)
                  .map((p) => (
                    <option key={`r${p.name}`} value={`l:repay:${p.name}`}>
                      {t(kind === "income" ? "statementRepaidBy" : "statementRepaidTo", { person: p.name })}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
        </label>
        {loan && (
          <p className="muted small">
            {t(loan.startsWith("l:repay:") ? "entryRepayHelp" : "entryLoanHelp", {
              person: loan.split(":").slice(2).join(":"),
              owed: money(
                people.find((p) => p.name === loan.split(":").slice(2).join(":"))?.[kind === "expense" ? "borrowed" : "lent"] ?? 0,
                lang,
              ),
            })}
          </p>
        )}
        <AccountField value={accountId} onChange={setAccountId} />
        <label className="field">
          <span>
            {kind === "expense" && split ? t("firstInstallmentDate") : kind === "expense" && unpaid ? t("expenseDueDate") : t("date")}
          </span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        {initial?.installment && (
          <p className="muted small">
            {t("installmentOf", { n: initial.installment.seq, count: initial.installment.count })}. {t("installmentEntryHelp")}
          </p>
        )}
        {kind === "expense" && !initial && !loan && (
          <label className="check">
            <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
            <span>{t("payInInstallments")}</span>
          </label>
        )}
        {kind === "expense" && split && (
          <fieldset className="fieldset">
            <legend>{t("installments")}</legend>
            <label className="field">
              <span>{t("installmentCount")}</span>
              <input
                type="number"
                inputMode="numeric"
                min={2}
                max={48}
                required
                value={count || ""}
                onChange={(e) => setCount(Number(e.target.value))}
              />
            </label>
            <div className="segmented">
              {INTERVALS.map((i) => (
                <button type="button" key={i.key} className={everyDays === i.days ? "active" : ""} onClick={() => setEveryDays(i.days)}>
                  {t(i.key)}
                </button>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={firstPaid} onChange={(e) => setFirstPaid(e.target.checked)} />
              <span>{t("firstInstallmentPaid")}</span>
            </label>
            {amount != null && amount >= count && count >= 2 && count <= 48 && (
              <ul className="installment-preview small">
                {splitAmount(amount, count).map((cents, i) => (
                  <li key={i}>
                    <span>
                      {i + 1}/{count} · {dateLabel(installmentDate(date, i, everyDays), lang)}
                      {i === 0 && firstPaid ? <span className="pos"> · {t("paidTag")}</span> : <span className="muted"> · {t("unpaidTag")}</span>}
                    </span>
                    <span className="num">{money(cents, lang)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">{t("installmentsHelp")}</p>
          </fieldset>
        )}
        {kind === "expense" && !split && !loan && (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={unpaid}
                onChange={(e) => {
                  setUnpaid(e.target.checked);
                  // Paying a bill that was due: it counts on the day it is paid.
                  if (!e.target.checked && initial && !initial.paid) setDate(todayISO());
                }}
              />
              <span>{t("unpaid")}</span>
            </label>
            {unpaid && <p className="muted small">{t("unpaidHelp")}</p>}
          </>
        )}
        <label className="field">
          <span>{t("description")}</span>
          <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          {initial && (!initial.installment || installmentPaid) && (
            <button type="button" className="btn danger" onClick={remove}>
              {t("delete")}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn primary" disabled={busy}>
            {t("save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
