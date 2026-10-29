import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../App";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { dateLabel, money } from "../format";
import { Loading, Money, MonthNav, ScheduledTag, useLoad } from "../components";
import TransactionForm from "../TransactionForm";
import type { Kind, LoanMove, Transaction, Transfer, UpcomingDebit } from "../../shared/types";

export default function Transactions() {
  const { t, lang } = useI18n();
  const { month, setMonth, categories, accounts } = useApp();
  const [filter, setFilter] = useState<Kind | "all">("all");
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState<number | "all">("all");
  const [editing, setEditing] = useState<Transaction | "new" | null>(null);
  // Search every month instead of the one shown.
  const [allMonths, setAllMonths] = useState(false);
  const scope = allMonths ? "" : `?month=${month}`;
  const { data, error, reload } = useLoad(() => api.get<Transaction[]>(`/transactions${scope}`), [scope]);
  // Subscriptions and loans not debited yet this month: shown as "upcoming" until their day comes.
  const { data: upcoming } = useLoad(
    () => (allMonths ? Promise.resolve([]) : api.get<UpcomingDebit[]>(`/transactions/upcoming?month=${month}`)),
    [scope],
  );
  // Personal loans and repayments are kept in Loans; they are listed here too, so every move shows.
  const { data: loanMoves, reload: reloadMoves } = useLoad(() => api.get<LoanMove[]>(`/loans/moves${scope}`), [scope]);
  // Transfers between my accounts are kept in Accounts; listed here so the month's moves are all in one place.
  const { data: transfers } = useLoad(() => api.get<Transfer[]>(`/transfers${scope}`), [scope]);
  const navigate = useNavigate();

  const catName = useMemo(() => new Map(categories.map((c) => [c.id, c.name])), [categories]);
  const accountName = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);
  const manyAccounts = accounts.length > 1;

  // Accents and case don't matter: "combustivel" finds "Combustível".
  const plain = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const q = plain(query.trim());
  const matches = (r: { kind: Kind; accountId: number; description: string; categoryId: number | null }) => {
    if (filter !== "all" && r.kind !== filter) return false;
    if (account !== "all" && r.accountId !== account) return false;
    if (!q) return true;
    return plain(r.description).includes(q) || plain(catName.get(r.categoryId ?? 0) ?? "").includes(q);
  };
  const rows = (data ?? []).filter(matches);
  const upcomingRows = (upcoming ?? []).filter((u) => matches({ ...u, kind: "expense", description: u.name }));
  const loanLabel = (m: LoanMove) =>
    t(m.repay ? (m.amountCents > 0 ? "statementRepaidBy" : "statementRepaidTo") : m.amountCents > 0 ? "statementLoanFrom" : "statementLoanTo", {
      person: m.person,
    });
  const loanRows = (loanMoves ?? []).filter((m) =>
    matches({
      kind: m.amountCents < 0 ? "expense" : "income",
      accountId: m.accountId ?? -1,
      description: `${loanLabel(m)} ${m.note}`,
      categoryId: null,
    }),
  );
  // Transfers are neither income nor expense; with one account picked they show as money in or out of it.
  const transferRows = (transfers ?? []).filter((x) => {
    if (filter !== "all") return false;
    if (account !== "all" && x.fromAccountId !== account && x.toAccountId !== account) return false;
    return !q || plain(`${accountName.get(x.fromAccountId) ?? ""} ${accountName.get(x.toAccountId) ?? ""} ${x.note}`).includes(q);
  });
  // Entries, loan moves and transfers together, newest first.
  const listed = [
    ...rows.map((r) => ({ date: r.date, entry: r })),
    ...loanRows.map((m) => ({ date: m.date, move: m })),
    ...transferRows.map((x) => ({ date: x.date, transfer: x })),
  ].sort((a, b) => b.date.localeCompare(a.date)) as (
    | { date: string; entry: Transaction; move?: never; transfer?: never }
    | { date: string; move: LoanMove; entry?: never; transfer?: never }
    | { date: string; transfer: Transfer; entry?: never; move?: never }
  )[];

  // What a search found adds up to (paid entries only, like the budget).
  const found = q || allMonths;
  const paid = rows.filter((r) => r.paid);
  const spent = paid.filter((r) => r.kind === "expense").reduce((s, r) => s + r.amountCents, 0);
  const received = paid.filter((r) => r.kind === "income").reduce((s, r) => s + r.amountCents, 0);

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("navTransactions")}</h1>
        <button className="btn primary fab" aria-label={t("add")} onClick={() => setEditing("new")}>
          <Icon name="plus" size={20} />
          <span className="fab-label">{t("add")}</span>
        </button>
      </header>
      {allMonths ? (
        <div className="month-nav all-months">
          <strong>{t("allMonths")}</strong>
          <button className="btn small-btn" onClick={() => setAllMonths(false)}>
            {t("backToMonth")}
          </button>
        </div>
      ) : (
        <MonthNav month={month} onChange={setMonth} />
      )}
      <div className="toolbar">
        <div className="segmented">
          {(["all", "expense", "income"] as const).map((k) => (
            <button key={k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>
              {k === "all" ? t("all") : k === "expense" ? t("expenses") : t("incomes")}
            </button>
          ))}
        </div>
        {manyAccounts && (
          <select
            className="filter-select"
            aria-label={t("account")}
            value={account}
            onChange={(e) => setAccount(e.target.value === "all" ? "all" : Number(e.target.value))}
          >
            <option value="all">{t("allAccounts")}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <input className="search" type="search" placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check-inline">
          <input type="checkbox" checked={allMonths} onChange={(e) => setAllMonths(e.target.checked)} />
          {t("searchAllMonths")}
        </label>
      </div>
      {data && found && (
        <p className="muted small search-total">
          {t("searchFound", { n: listed.length })}
          {spent > 0 && <> · {t("expenses")}: {money(spent, lang)}</>}
          {received > 0 && <> · {t("incomes")}: {money(received, lang)}</>}
        </p>
      )}
      {!data ? (
        <Loading error={error} />
      ) : listed.length === 0 && upcomingRows.length === 0 ? (
        <p className="muted center">{t("nothingYet")}</p>
      ) : (
        <ul className="list card entries">
          {[...upcomingRows].reverse().map((u) => (
            <li key={`upcoming-${u.source}-${u.itemId}-${u.date}`} className="upcoming">
              <button className="list-row" onClick={() => navigate(u.source === "loan" ? "/loans" : "/plan")}>
                <div className="list-main">
                  <strong>{u.name}</strong>
                  <span className="muted small">
                    {dateLabel(u.date, lang)}
                    {u.categoryId ? ` · ${catName.get(u.categoryId) ?? ""}` : ""}
                    {manyAccounts ? ` · ${accountName.get(u.accountId) ?? ""}` : ""}
                    <span className="tag-upcoming"> · {t("upcomingTag")}</span>
                  </span>
                </div>
                <Money cents={-u.amountCents} signed />
              </button>
            </li>
          ))}
          {listed.map(({ entry: r, move: m, transfer: x }) =>
            x ? (
              <li key={`transfer-${x.id}`} className={x.scheduled ? "upcoming" : undefined}>
                <button className="list-row" onClick={() => navigate("/accounts")}>
                  <div className="list-main">
                    <strong>
                      {accountName.get(x.fromAccountId)} → {accountName.get(x.toAccountId)}
                    </strong>
                    <span className="muted small">
                      {dateLabel(x.date, lang)}
                      {x.note ? ` · ${x.note}` : ""}
                      <span className="tag-upcoming"> · {t("transferTag")}</span>
                      {x.scheduled && <ScheduledTag date={x.date} />}
                    </span>
                  </div>
                  {account === "all" ? (
                    <Money cents={x.amountCents} />
                  ) : (
                    <Money cents={x.toAccountId === account ? x.amountCents : -x.amountCents} signed />
                  )}
                </button>
              </li>
            ) : m ? (
              <li key={m.key} className={m.scheduled ? "upcoming" : undefined}>
                <button className="list-row" onClick={() => navigate("/loans")}>
                  <div className="list-main">
                    <strong>{loanLabel(m)}</strong>
                    <span className="muted small">
                      {dateLabel(m.date, lang)}
                      {m.note ? ` · ${m.note}` : ""}
                      {manyAccounts && m.accountId ? ` · ${accountName.get(m.accountId) ?? ""}` : ""}
                      <span className="tag-upcoming"> · {t("loanTag")}</span>
                      {m.scheduled && <ScheduledTag date={m.date} />}
                    </span>
                  </div>
                  <Money cents={m.amountCents} signed />
                </button>
              </li>
            ) : (
              <li key={r.id} className={r.scheduled ? "upcoming" : undefined}>
                <button className="list-row" onClick={() => setEditing(r)}>
                  <div className="list-main">
                    <strong>
                      {r.description || catName.get(r.categoryId ?? 0) || t("noCategory")}
                      {r.installment && <span className="muted"> ({r.installment.seq}/{r.installment.count})</span>}
                    </strong>
                    <span className="muted small">
                      {dateLabel(r.date, lang)}
                      {r.description && r.categoryId ? ` · ${catName.get(r.categoryId) ?? ""}` : ""}
                      {manyAccounts ? ` · ${accountName.get(r.accountId) ?? ""}` : ""}
                      {r.scheduled ? <ScheduledTag date={r.date} /> : !r.paid && <span className="neg"> · {t("unpaidTag")}</span>}
                    </span>
                  </div>
                  <Money cents={r.kind === "expense" ? -r.amountCents : r.amountCents} signed />
                </button>
              </li>
            ),
          )}
        </ul>
      )}
      {editing && (
        <TransactionForm
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            reload();
            reloadMoves();
          }}
        />
      )}
    </div>
  );
}
