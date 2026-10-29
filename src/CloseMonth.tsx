import { useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { useI18n, type Lang } from "./i18n";
import { monthLabel } from "./format";
import { addMonths } from "../shared/period";
import { Loading, Modal, Money, MoneyField, useLoad } from "./components";
import type { Account, MonthSummary } from "../shared/types";

/** "outubro" in Portuguese, "October" in English: a month name inside a sentence. */
export function monthName(month: string, lang: Lang): string {
  const name = monthLabel(month, lang).split(" ")[0];
  return lang === "pt" ? name.toLowerCase() : name;
}

/**
 * Closing a budget month: a look at how it ended, the account balances
 * checked against the bank, and then the month is locked. No money is moved
 * to the next month: it is already in the accounts.
 */
export default function CloseMonth({ month, onClose, onDone }: { month: string; onClose: () => void; onDone: () => void }) {
  const { t, lang } = useI18n();
  const { data, error } = useLoad(
    () =>
      Promise.all([
        api.get<MonthSummary>(`/summary?month=${month}`),
        // Fresh balances, not the ones loaded when the app opened.
        api.get<Account[]>("/accounts"),
      ]).then(([summary, accounts]) => ({ summary, accounts: accounts.filter((a) => !a.archived) })),
    [month],
  );
  const [bank, setBank] = useState<Record<number, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (data) setBank(Object.fromEntries(data.accounts.map((a) => [a.id, a.balanceCents])));
  }, [data]);

  const title = t("closeMonthTitle", { month: monthName(month, lang) });
  if (!data) return <Modal title={title} onClose={onClose}><Loading error={error} /></Modal>;
  const { summary, accounts } = data;
  const balance = summary.balanceCents;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (accounts.some((a) => bank[a.id] == null)) {
      setErr(t("invalidAmount"));
      return;
    }
    setBusy(true);
    try {
      await api.post("/month-close", { month, balances: accounts.map((a) => ({ accountId: a.id, bankCents: bank[a.id] })) });
      onDone();
    } catch {
      setErr(t("error"));
      setBusy(false);
    }
  };

  const line = (label: string, cents: number, signed?: boolean) => (
    <div className="budget-row">
      <span className="budget-name">{label}</span>
      <span className="budget-nums">
        <Money cents={cents} signed={signed} />
      </span>
    </div>
  );

  return (
    <Modal title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="close-summary">
          {line(t("incomes"), summary.totalIncomeCents)}
          {line(t("expenses"), -summary.totalExpenseCents, true)}
          {summary.savingsCents > 0 && line(t("savingsLine"), -summary.savingsCents, true)}
          {summary.repaidCents > 0 && line(t("repaidTitle"), -summary.repaidCents, true)}
          <div className="budget-row close-total">
            <strong>{balance < 0 ? t("closeShortfall") : t("closeLeftover")}</strong>
            <strong className={balance < 0 ? "neg" : "pos"}>
              <Money cents={Math.abs(balance)} />
            </strong>
          </div>
          <p className="muted small">
            {t("closePlanned")}: <Money cents={summary.plannedIncomeCents - summary.plannedExpenseCents - summary.plannedSavingsCents} />
          </p>
        </div>

        {summary.pendingCents > 0 && (
          <p className="notice small">
            {t("closePendingCarry", { count: summary.pending.length, month: monthName(addMonths(month, 1), lang) })}{" "}
            <Money cents={summary.pendingCents} />
          </p>
        )}

        <fieldset className="fieldset">
          <legend>{t("closeBalances")}</legend>
          <p className="muted small">{t("closeBalancesHelp")}</p>
          {accounts.map((a) => {
            const diff = (bank[a.id] ?? a.balanceCents) - a.balanceCents;
            return (
              <div key={a.id} className="close-account">
                <MoneyField key={String(a.id in bank)} label={a.name} cents={bank[a.id] ?? null} onChange={(c) => setBank((b) => ({ ...b, [a.id]: c }))} />
                <span className="muted small">
                  {t("closeInApp")}: <Money cents={a.balanceCents} />
                  {diff !== 0 && (
                    <>
                      {" · "}
                      {t("closeAdjust")} <Money cents={diff} signed />
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </fieldset>

        <p className="muted small">{t("closeLockHelp", { month: monthName(month, lang) })}</p>
        {err && <p className="error">{err}</p>}
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn primary" disabled={busy}>
            {t("closeMonthButton", { month: monthName(month, lang) })}
          </button>
        </div>
      </form>
    </Modal>
  );
}
