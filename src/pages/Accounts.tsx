import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../icons";
import { api, ApiError } from "../api";
import { useApp } from "../App";
import { useI18n } from "../i18n";
import { dateLabel, money, monthLabel } from "../format";
import { Loading, Modal, Money, MoneyField, MonthNav, Section, useLoad } from "../components";
import { todayISO } from "../../shared/period";
import type { Account, Transfer, TransferNeed, TransferPlan } from "../../shared/types";

function AccountForm({ account, onClose, onSaved }: { account?: Account; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(account?.name ?? "");
  // People know what the bank shows today, not what the account had before the
  // first entry, so the form asks for the current balance and derives the opening one.
  const movedCents = account ? account.balanceCents - account.openingCents : 0;
  const [current, setCurrent] = useState<number | null>(account?.balanceCents ?? 0);
  const [isDefault, setIsDefault] = useState(account?.isDefault ?? false);
  const [archived, setArchived] = useState(account?.archived ?? false);
  const [error, setError] = useState<string | null>(null);

  const fail = (e: unknown) =>
    setError(
      e instanceof ApiError && e.code === "duplicate_name"
        ? t("duplicateName")
        : e instanceof ApiError && e.code === "account_in_use"
          ? t("accountInUse")
          : t("error"),
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (current == null) {
      setError(t("invalidAmount"));
      return;
    }
    try {
      await api.post("/accounts", {
        id: account?.id,
        name,
        openingCents: current - movedCents,
        isDefault,
        archived: isDefault ? false : archived,
        sort: account?.sort ?? 99,
      });
      onSaved();
      onClose();
    } catch (err) {
      fail(err);
    }
  };
  const remove = async () => {
    if (!account || !confirm(t("confirmDelete"))) return;
    try {
      await api.del(`/accounts/${account.id}`);
      onSaved();
      onClose();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <Modal title={account ? account.name : t("newAccount")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("name")}</span>
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <MoneyField label={t("currentBalance")} cents={current} onChange={setCurrent} />
        <p className="muted small">{t("accountOpeningHelp")}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={isDefault}
            disabled={account?.isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          <span>{t("defaultAccount")}</span>
        </label>
        <p className="muted small">{t("defaultAccountHelp")}</p>
        {!isDefault && (
          <>
            <label className="check">
              <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
              <span>{t("archived")}</span>
            </label>
            <p className="muted small">{t("archivedAccountHelp")}</p>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          {account && !account.isDefault && (
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

function TransferForm({
  accounts,
  initial,
  onClose,
  onSaved,
}: {
  accounts: Account[];
  initial?: Transfer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const usable = accounts.filter((a) => !a.archived || a.id === initial?.fromAccountId || a.id === initial?.toAccountId);
  const main = usable.find((a) => a.isDefault) ?? usable[0];
  const [from, setFrom] = useState(initial?.fromAccountId ?? main.id);
  const [to, setTo] = useState(initial?.toAccountId ?? (usable.find((a) => a.id !== main.id) ?? main).id);
  const [amount, setAmount] = useState<number | null>(initial?.amountCents ?? null);
  const [date, setDate] = useState(initial?.date ?? todayISO());
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (amount == null || amount <= 0) {
      setError(t("invalidAmount"));
      return;
    }
    if (from === to) {
      setError(t("sameAccount"));
      return;
    }
    try {
      await api.post("/transfers", { id: initial?.id, date, amountCents: amount, fromAccountId: from, toAccountId: to, note });
      onSaved();
      onClose();
    } catch {
      setError(t("error"));
    }
  };
  const remove = async () => {
    if (!initial || !confirm(t("confirmDelete"))) return;
    await api.del(`/transfers/${initial.id}`);
    onSaved();
    onClose();
  };

  const select = (value: number, set: (n: number) => void, label: string) => (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => set(Number(e.target.value))}>
        {usable.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Modal title={t("newTransfer")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted small">{t("transferHelp")}</p>
        {select(from, setFrom, t("fromAccount"))}
        {select(to, setTo, t("toAccount"))}
        <MoneyField label={t("amount")} cents={amount} onChange={setAmount} autoFocus={!initial} />
        <label className="field">
          <span>{t("date")}</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("note")}</span>
          <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          {initial && (
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

/** Records the month's transfer to one account, with the suggested amount filled in. */
function ConfirmTransferForm({
  plan,
  need,
  accounts,
  onClose,
  onSaved,
}: {
  plan: TransferPlan;
  need: TransferNeed;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const name = (id: number) => accounts.find((a) => a.id === id)?.name ?? "";
  const today = todayISO();
  const [amount, setAmount] = useState<number | null>(need.neededCents);
  // Payday, or today when payday has passed.
  const [date, setDate] = useState(today > plan.payday ? today : plan.payday);
  const [note, setNote] = useState(t("monthlyTransferNote", { month: monthLabel(plan.month, lang) }));
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (amount == null || amount <= 0) {
      setError(t("invalidAmount"));
      return;
    }
    try {
      await api.post("/transfer-plan/confirm", { month: plan.month, toAccountId: need.accountId, amountCents: amount, date, note });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "already_done" ? t("alreadyTransferred") : t("error"));
    }
  };

  return (
    <Modal title={`${name(plan.salaryAccountId)} → ${name(need.accountId)}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted small">{t("monthlyTransferOnce")}</p>
        <MoneyField label={t("amount")} cents={amount} onChange={setAmount} autoFocus />
        <label className="field">
          <span>{t("date")}</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
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
          <button className="btn primary">{t("monthlyTransferConfirm")}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * What to move on payday from the account the salary comes into to each other
 * account, so each one can pay its planned debits in the month the salary pays for.
 */
function MonthlyTransfers({
  plan,
  accounts,
  onChanged,
  onOpenTransfer,
}: {
  plan: TransferPlan;
  accounts: Account[];
  onChanged: () => void;
  onOpenTransfer: (t: Transfer) => void;
}) {
  const { t, lang } = useI18n();
  const { refresh } = useApp();
  const [confirming, setConfirming] = useState<TransferNeed | null>(null);
  const name = (id: number) => accounts.find((a) => a.id === id)?.name ?? "";
  const usable = accounts.filter((a) => !a.archived || a.id === plan.salaryAccountId);

  const setSalaryAccount = async (id: number) => {
    await api.put("/settings", { salaryAccountId: id });
    onChanged();
    refresh().catch(() => {});
  };
  const partName = (p: TransferNeed["parts"][number]) =>
    p.kind === "unpaid" ? t("partUnpaid", { name: p.name }) : p.kind === "annual" ? t("partAnnual", { name: p.name }) : p.name;

  return (
    <Section title={t("monthlyTransfers")}>
      <label className="field inline-field">
        <span>{t("salaryComesInto")}</span>
        <select value={plan.salaryAccountId} onChange={(e) => setSalaryAccount(Number(e.target.value))}>
          {usable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        {t("monthlyTransferHelp", { payday: dateLabel(plan.payday, lang), month: monthLabel(plan.month, lang) })}
      </p>
      {plan.needs.length === 0 ? (
        <p className="muted">{t("monthlyTransferNone")}</p>
      ) : (
        <ul className="list transfer-needs">
          {plan.needs.map((n) => (
            <li key={n.accountId} className="transfer-need">
              <div className="transfer-need-head">
                <div className="list-main">
                  <strong>
                    {name(plan.salaryAccountId)} → {name(n.accountId)}
                  </strong>
                  <span className="muted small">
                    {t("currentBalance")}{" "}
                    <span className={n.balanceCents < 0 ? "neg" : ""}>{money(n.balanceCents, lang)}</span>
                  </span>
                </div>
                <strong className="num transfer-need-amount">{money(n.neededCents, lang)}</strong>
              </div>
              <details className="transfer-parts">
                <summary className="muted small">{t("monthlyTransferDetail")}</summary>
                <ul>
                  {n.parts.map((p) => (
                    <li key={`${p.kind}-${p.name}`}>
                      <span>{partName(p)}</span>
                      <Money cents={p.cents} />
                    </li>
                  ))}
                </ul>
              </details>
              {n.transfer ? (
                <button className="link transfer-done" onClick={() => onOpenTransfer(n.transfer!)}>
                  ✓ {t("monthlyTransferDone", { amount: money(n.transfer.amountCents, lang), date: dateLabel(n.transfer.date, lang) })}
                </button>
              ) : (
                <button className="btn primary" onClick={() => setConfirming(n)}>
                  {t("monthlyTransferConfirm")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirming && (
        <ConfirmTransferForm
          plan={plan}
          need={confirming}
          accounts={accounts}
          onClose={() => setConfirming(null)}
          onSaved={onChanged}
        />
      )}
    </Section>
  );
}

export default function Accounts() {
  const { t, lang } = useI18n();
  const { month, setMonth, refresh } = useApp();
  const { data, error, reload } = useLoad(
    () =>
      Promise.all([
        api.get<Account[]>("/accounts"),
        api.get<Transfer[]>(`/transfers?month=${month}`),
        api.get<TransferPlan>(`/transfer-plan?month=${month}`),
      ]).then(([accounts, transfers, plan]) => ({ accounts, transfers, plan })),
    [month],
  );
  const [accountForm, setAccountForm] = useState<Account | "new" | null>(null);
  const [transferForm, setTransferForm] = useState<Transfer | "new" | null>(null);

  if (!data) return <Loading error={error} />;
  const total = data.accounts.reduce((a, x) => a + x.balanceCents, 0);
  const name = new Map(data.accounts.map((a) => [a.id, a.name]));
  const onAccountSaved = () => {
    reload();
    refresh().catch(() => {});
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("navAccounts")}</h1>
        <div className="head-actions">
          <Link className="btn" to="/accounts/import">
            <Icon name="import" size={18} />
            {t("statementButton")}
          </Link>
          <button className="btn" onClick={() => setAccountForm("new")}>
            + {t("newAccount")}
          </button>
          {data.accounts.length > 1 && (
            <button className="btn primary" onClick={() => setTransferForm("new")}>
              ⇄ {t("transfer")}
            </button>
          )}
        </div>
      </header>
      <div className="card hero">
        <span className="muted">{t("totalAccounts")}</span>
        <div className={`hero-value ${total < 0 ? "neg" : ""}`}>{money(total, lang)}</div>
      </div>

      <div className="pots">
        {data.accounts.map((a) => (
          <div className={`card pot ${a.archived ? "archived" : ""}`} key={a.id}>
            <button className="pot-name" onClick={() => setAccountForm(a)}>
              {a.name}
            </button>
            <strong className={`num pot-balance ${a.balanceCents < 0 ? "neg" : ""}`}>{money(a.balanceCents, lang)}</strong>
            <span className="muted small">
              {a.isDefault ? t("defaultAccount") : a.archived ? t("archived") : " "}
            </span>
          </div>
        ))}
      </div>

      <MonthNav month={month} onChange={setMonth} />
      {data.accounts.length > 1 && (
        <MonthlyTransfers plan={data.plan} accounts={data.accounts} onChanged={onAccountSaved} onOpenTransfer={setTransferForm} />
      )}
      <Section title={t("transfersThisMonth")}>
        {data.transfers.length === 0 ? (
          <p className="muted">{t("nothingYet")}</p>
        ) : (
          <ul className="list">
            {data.transfers.map((x) => (
              <li key={x.id}>
                <button className="list-row" onClick={() => setTransferForm(x)}>
                  <div className="list-main">
                    <strong>
                      {name.get(x.fromAccountId)} → {name.get(x.toAccountId)}
                    </strong>
                    <span className="muted small">
                      {dateLabel(x.date, lang)}
                      {x.note ? ` · ${x.note}` : ""}
                    </span>
                  </div>
                  <Money cents={x.amountCents} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {accountForm && (
        <AccountForm
          account={accountForm === "new" ? undefined : accountForm}
          onClose={() => setAccountForm(null)}
          onSaved={onAccountSaved}
        />
      )}
      {transferForm && (
        <TransferForm
          accounts={data.accounts}
          initial={transferForm === "new" ? undefined : transferForm}
          onClose={() => setTransferForm(null)}
          onSaved={onAccountSaved}
        />
      )}
    </div>
  );
}
