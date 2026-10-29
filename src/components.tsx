import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useI18n, type Key } from "./i18n";
import { dateLabel, money, monthLabel, moneyInput, parseMoney } from "./format";
import { addMonths, todayISO } from "../shared/period";
import { Icon } from "./icons";
import { api } from "./api";
import { useApp } from "./App";
import type { ExpenseGroup } from "../shared/types";

/**
 * Picks the account a day-to-day category is spent from, or none: it stays
 * in the salary account, which is the first option. Shown only when there is
 * more than one account.
 */
export function SpentFromSelect({ value, onChange }: { value: number | null; onChange: (id: number | null) => void }) {
  const { t } = useI18n();
  const { accounts, settings } = useApp();
  const salary = accounts.find((a) => a.id === settings.salaryAccountId) ?? accounts.find((a) => a.isDefault);
  const options = accounts.filter((a) => a.id !== salary?.id && (!a.archived || a.id === value));
  if (options.length < 1) return null;
  return (
    <select className="spent-from" aria-label={t("spentFrom")} value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{salary ? salary.name : t("salaryAccountStays")}</option>
      {options.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

/** The tables expenses are split into on the Budget and Year plan, in order. */
export const EXPENSE_GROUPS: { group: ExpenseGroup; label: Key }[] = [
  { group: "credit", label: "groupCredit" },
  { group: "fixed", label: "groupFixed" },
  { group: "variable", label: "groupVariable" },
];

/** Loads data and exposes a reload function; `deps` re-trigger the load. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(fn, deps);
  const reload = useCallback(() => {
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [load]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

export function Loading({ error }: { error?: string | null }) {
  const { t } = useI18n();
  return <p className="muted center">{error ? t("error") : t("loading")}</p>;
}

export function MonthNav({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const { t, lang } = useI18n();
  return (
    <div className="month-nav">
      <button className="icon-btn" aria-label={t("previousMonth")} onClick={() => onChange(addMonths(month, -1))}>
        <Icon name="left" size={18} />
      </button>
      <strong>{monthLabel(month, lang)}</strong>
      <button className="icon-btn" aria-label={t("nextMonth")} onClick={() => onChange(addMonths(month, 1))}>
        <Icon name="right" size={18} />
      </button>
    </div>
  );
}

/** " · scheduled" before its day, " · to confirm" once the day has come: it doesn't count yet. */
export function ScheduledTag({ date }: { date: string }) {
  const { t } = useI18n();
  return date > todayISO() ? (
    <span className="tag-upcoming"> · {t("scheduledTag")}</span>
  ) : (
    <span className="neg"> · {t("toConfirmTag")}</span>
  );
}

/** Under a date field: a date after today only counts once confirmed on that day. */
export function ScheduledHint({ date }: { date: string }) {
  const { t, lang } = useI18n();
  return date > todayISO() ? <p className="muted small">{t("scheduledHelp", { date: dateLabel(date, lang) })}</p> : null;
}

export function Money({ cents, signed }: { cents: number; signed?: boolean }) {
  const { lang } = useI18n();
  const cls = signed ? (cents < 0 ? "neg" : cents > 0 ? "pos" : "") : "";
  return <span className={`num ${cls}`}>{money(cents, lang)}</span>;
}

/** Bar showing actual against planned; turns red when actual goes over. */
export function Progress({ actual, planned, inverse }: { actual: number; planned: number; inverse?: boolean }) {
  const pct = planned > 0 ? Math.min(100, (actual / planned) * 100) : actual > 0 ? 100 : 0;
  const over = inverse ? actual < planned : actual > planned;
  return (
    <div className="progress" role="presentation">
      <div className={`progress-fill ${over && planned > 0 ? "over" : ""} ${planned === 0 && actual > 0 ? "unplanned" : ""}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Closes only through its × (or the form's own buttons): tapping outside or Escape would lose what was typed. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="×" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Text field for euros; reports cents (or null while the text is not a valid amount). */
export function MoneyField({
  label,
  cents,
  onChange,
  autoFocus,
}: {
  label: string;
  cents: number | null;
  onChange: (c: number | null) => void;
  autoFocus?: boolean;
}) {
  const { lang } = useI18n();
  const [text, setText] = useState(cents == null ? "" : moneyInput(cents, lang));
  return (
    <label className="field">
      <span>{label}</span>
      <div className="money-input">
        <input
          inputMode="decimal"
          autoFocus={autoFocus}
          value={text}
          placeholder="0,00"
          onChange={(e) => {
            setText(e.target.value);
            onChange(parseMoney(e.target.value));
          }}
        />
        <span className="suffix">€</span>
      </div>
    </label>
  );
}

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A planned amount for one budget month (a category, or savings with no category); saved on blur. */
export function PlannedInput({ month, categoryId, cents, onSaved }: { month: string; categoryId: number | null; cents: number; onSaved: () => void }) {
  const { lang } = useI18n();
  const [text, setText] = useState(moneyInput(cents, lang));
  useEffect(() => setText(moneyInput(cents, lang)), [cents, lang]);
  const save = async () => {
    const value = parseMoney(text || "0");
    if (value == null || value === cents) return;
    await api.post("/month-plans", { month, categoryId, cents: value });
    onSaved();
  };
  return (
    <input
      className="inline-money"
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}
