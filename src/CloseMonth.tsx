import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";
import { useApp } from "./App";
import { useI18n, type Lang } from "./i18n";
import { monthLabel } from "./format";
import { addMonths } from "../shared/period";
import { Loading, Modal, Money, MoneyField, useLoad } from "./components";
import type { Account, CloseAction, MonthSummary, SavingsPot } from "../shared/types";

/** "outubro" in Portuguese, "October" in English: a month name inside a sentence. */
export function monthName(month: string, lang: Lang): string {
  const name = monthLabel(month, lang).split(" ")[0];
  return lang === "pt" ? name.toLowerCase() : name;
}

/**
 * Closing a budget month: a look at how it ended, where the leftover goes (or
 * how a shortfall is covered), the account balances set to what the bank
 * shows, and then the month is locked.
 */
export default function CloseMonth({ month, onClose, onDone }: { month: string; onClose: () => void; onDone: () => void }) {
  const { t, lang } = useI18n();
  const { accounts: known, settings } = useApp();
  const { data, error } = useLoad(
    () =>
      Promise.all([
        api.get<MonthSummary>(`/summary?month=${month}`),
        api.get<{ pots: SavingsPot[] }>("/savings"),
        // Fresh balances, not the ones loaded when the app opened.
        api.get<Account[]>("/accounts"),
      ]).then(([summary, savings, accounts]) => ({ summary, pots: savings.pots, accounts: accounts.filter((a) => !a.archived) })),
    [month],
  );
  const [action, setAction] = useState<CloseAction>("carry");
  const [potId, setPotId] = useState<number | null>(null);
  const [potCents, setPotCents] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | null>(settings.salaryAccountId ?? known.find((a) => a.isDefault)?.id ?? null);
  const [bank, setBank] = useState<Record<number, number | null>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const balance = data?.summary.balanceCents ?? 0;
  const short = balance < 0;
  useEffect(() => {
    if (!data) return;
    const pot = data.pots[0];
    setPotId(pot?.id ?? null);
    setPotCents(short && pot ? Math.min(-balance, Math.max(0, pot.balanceCents)) : Math.abs(balance));
    setBank(Object.fromEntries(data.accounts.map((a) => [a.id, a.balanceCents])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (!data) return <Modal title={t("closeMonthTitle", { month: monthName(month, lang) })} onClose={onClose}><Loading error={error} /></Modal>;
  const { summary, pots, accounts: open } = data;
  const next = monthName(addMonths(month, 1), lang);
  const pot = pots.find((p) => p.id === potId);
  const rest = action === "pot" ? Math.abs(balance) - (potCents ?? 0) : 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (open.some((a) => bank[a.id] == null) || (action === "pot" && (potCents == null || potCents < 1))) {
      setErr(t("invalidAmount"));
      return;
    }
    if (action === "pot" && potCents! > Math.abs(balance)) {
      setErr(t("closeTooMuch"));
      return;
    }
    if (action === "pot" && short && pot && potCents! > pot.balanceCents) {
      setErr(t("closePotTooSmall"));
      return;
    }
    setBusy(true);
    try {
      await api.post("/month-close", {
        month,
        action: balance === 0 ? "none" : action,
        potId: action === "pot" ? potId : null,
        potCents: action === "pot" ? potCents : 0,
        accountId: action === "pot" ? accountId : null,
        balances: open.map((a) => ({ accountId: a.id, bankCents: bank[a.id] })),
      });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "pot_too_small" ? t("closePotTooSmall") : t("error"));
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
    <Modal title={t("closeMonthTitle", { month: monthName(month, lang) })} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="close-summary">
          {line(t("incomes"), summary.totalIncomeCents)}
          {line(t("expenses"), -summary.totalExpenseCents, true)}
          {summary.savingsCents > 0 && line(t("savingsLine"), -summary.savingsCents, true)}
          {summary.repaidCents > 0 && line(t("repaidTitle"), -summary.repaidCents, true)}
          {summary.carriedInCents !== 0 && line(t("carriedInFrom", { month: monthName(addMonths(month, -1), lang) }), summary.carriedInCents, true)}
          <div className="budget-row close-total">
            <strong>{short ? t("closeShortfall") : t("closeLeftover")}</strong>
            <strong className={short ? "neg" : "pos"}>
              <Money cents={Math.abs(balance)} />
            </strong>
          </div>
          <p className="muted small">
            {t("closePlanned")}: <Money cents={summary.plannedIncomeCents - summary.plannedExpenseCents - summary.plannedSavingsCents} />
          </p>
        </div>

        {summary.pendingCents > 0 && (
          <p className="notice small">
            {t("closePendingCarry", { count: summary.pending.length, month: next })} <Money cents={summary.pendingCents} />
          </p>
        )}

        {balance !== 0 && (
          <fieldset className="fieldset">
            <legend>{short ? t("closeShortfallWhere") : t("closeLeftoverWhere")}</legend>
            <div className="segmented wrap">
              <button type="button" className={action === "carry" ? "active" : ""} onClick={() => setAction("carry")}>
                {t("closeCarry", { month: next })}
              </button>
              {pots.length > 0 && (
                <button type="button" className={action === "pot" ? "active" : ""} onClick={() => setAction("pot")}>
                  {short ? t("closeFromPot") : t("closeToPot")}
                </button>
              )}
              <button type="button" className={action === "none" ? "active" : ""} onClick={() => setAction("none")}>
                {t("closeNothing")}
              </button>
            </div>
            {action === "pot" && (
              <>
                <label className="field">
                  <span>{t("pots")}</span>
                  <select value={potId ?? ""} onChange={(e) => setPotId(Number(e.target.value))}>
                    {pots.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                {short && pot && (
                  <p className="muted small">
                    {t("closePotHas")} <Money cents={pot.balanceCents} />
                  </p>
                )}
                <MoneyField label={t("amount")} cents={potCents} onChange={setPotCents} />
                <label className="field">
                  <span>{short ? t("toAccount") : t("fromAccount")}</span>
                  <select value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
                    {open.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                    <option value="">{t("noAccount")}</option>
                  </select>
                </label>
                {rest > 0 && (
                  <p className="muted small">
                    {t("closeRestCarry", { month: next })} <Money cents={short ? -rest : rest} signed />
                  </p>
                )}
              </>
            )}
            {action === "carry" && <p className="muted small">{short ? t("closeCarryShortHelp", { month: next }) : t("closeCarryHelp", { month: next })}</p>}
            {action === "none" && <p className="muted small">{t("closeNothingHelp")}</p>}
          </fieldset>
        )}

        <fieldset className="fieldset">
          <legend>{t("closeBalances")}</legend>
          <p className="muted small">{t("closeBalancesHelp")}</p>
          {open.map((a) => {
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
