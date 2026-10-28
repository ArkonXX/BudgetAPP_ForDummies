import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { useApp } from "../App";
import { useI18n, type Key } from "../i18n";
import { dateLabel, money } from "../format";
import { Money, Section, useLoad } from "../components";
import type { PersonalLoan, SavingsPot, StatementPreview, StatementRow } from "../../shared/types";

// What a reviewed line becomes: "" = no category, "c:<id>" = a category,
// "t:<id>" = a transfer with that account, "p:<id>" = money into or out of that savings pot,
// "l:new:<person>" / "l:repay:<person>" = a personal loan or a repayment, "l:other" = a loan with
// someone not in Loans yet, named in `person`.
type Line = StatementRow & { use: boolean; as: string; person: string; suggested: boolean };

// What is still owed in each direction, per person in Loans (keyed by lowercase name).
type People = Map<string, { name: string; lent: number; borrowed: number }>;

function peopleOf(loans: PersonalLoan[]): People {
  const people: People = new Map();
  for (const l of loans) {
    const key = l.person.trim().toLocaleLowerCase("pt-PT");
    const p = people.get(key) ?? { name: l.person.trim(), lent: 0, borrowed: 0 };
    p[l.direction] += l.outstandingCents;
    people.set(key, p);
  }
  return people;
}

/** Money in from someone who owes me is them paying back; otherwise it's a new loan. Same for money out. */
function suggestLoan(row: StatementRow, people: People): string {
  const p = people.get(row.loanPerson!.toLocaleLowerCase("pt-PT"));
  const owed = row.amountCents > 0 ? p?.lent : p?.borrowed;
  return `l:${owed && owed >= Math.abs(row.amountCents) ? "repay" : "new"}:${row.loanPerson}`;
}

const SKIP: Record<NonNullable<StatementRow["skip"]>, Key> = {
  notCompleted: "statementPending",
  currency: "statementCurrency",
  otherProduct: "statementOtherProduct",
};

const ERRORS: Record<string, Key> = {
  more_than_owed: "statementMoreThanOwed",
  unrecognized_statement: "statementUnrecognized",
  xls_not_supported: "statementXls",
  no_lines: "statementEmpty",
};

export default function BankImport() {
  const { t, lang } = useI18n();
  const { accounts, categories, refresh } = useApp();
  const usable = accounts.filter((a) => !a.archived);
  const [accountId, setAccountId] = useState((usable.find((a) => a.isDefault) ?? usable[0]).id);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [format, setFormat] = useState<StatementPreview["format"] | null>(null);
  const [onlyNew, setOnlyNew] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pots = useLoad(() => api.get<{ pots: SavingsPot[] }>("/savings").then((r) => r.pots), []).data ?? [];
  const people = peopleOf(useLoad(() => api.get<{ personal: PersonalLoan[] }>("/loans").then((r) => r.personal), []).data ?? []);

  const read = async (file: File) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const p = await api.upload<StatementPreview>(`/bank-import/preview?account=${accountId}`, file);
      setFormat(p.format);
      setLines(
        p.rows.map((r) => {
          // A category used before for the same description wins over a name in it.
          const suggested = !r.categoryId && r.loanPerson != null;
          return {
            ...r,
            use: !r.duplicate && !r.skip && !r.closed,
            as: r.categoryId ? `c:${r.categoryId}` : suggested ? suggestLoan(r, people) : "",
            person: "",
            suggested,
          };
        }),
      );
    } catch (e) {
      setLines(null);
      setError(e instanceof ApiError && ERRORS[e.code] ? t(ERRORS[e.code]) : t("error"));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const chosen = lines?.filter((l) => l.use) ?? [];
  const outCents = chosen.filter((l) => l.amountCents < 0).reduce((s, l) => s + l.amountCents, 0);
  const inCents = chosen.filter((l) => l.amountCents > 0).reduce((s, l) => s + l.amountCents, 0);

  const update = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls && ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async () => {
    if (!chosen.length) return;
    if (chosen.some((l) => l.as === "l:other" && !l.person.trim())) {
      setError(t("statementNamePerson"));
      return;
    }
    if (!confirm(t("statementConfirm", { n: chosen.length, out: money(-outCents, lang), in: money(inCents, lang) }))) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ transactions: number; transfers: number; savings: number; loans: number }>("/bank-import/commit", {
        accountId,
        lines: chosen.map((l) => ({
          date: l.date,
          description: l.description,
          amountCents: l.amountCents,
          categoryId: l.as.startsWith("c:") ? Number(l.as.slice(2)) : null,
          transferAccountId: l.as.startsWith("t:") ? Number(l.as.slice(2)) : null,
          potId: l.as.startsWith("p:") ? Number(l.as.slice(2)) : null,
          loan: !l.as.startsWith("l:")
            ? null
            : l.as === "l:other"
              ? { person: l.person.trim(), repay: false }
              : { person: l.as.split(":").slice(2).join(":"), repay: l.as.startsWith("l:repay:") },
        })),
      });
      setDone(t("statementDone", { transactions: r.transactions, transfers: r.transfers, savings: r.savings, loans: r.loans }));
      setLines(null);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError && ERRORS[e.code] ? t(ERRORS[e.code]) : t("error"));
    } finally {
      setBusy(false);
    }
  };

  const account = accounts.find((a) => a.id === accountId)!;
  const others = usable.filter((a) => a.id !== accountId);
  const shown = lines?.map((l, i) => ({ l, i })).filter(({ l }) => !onlyNew || (!l.duplicate && !l.skip && !l.closed)) ?? [];
  const hidden = (lines?.length ?? 0) - shown.length;

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("statementTitle")}</h1>
        <Link className="btn" to="/accounts">
          {t("close")}
        </Link>
      </header>

      <Section title={t("statementFile")}>
        <div className="form">
          <p className="muted small">{t("statementHelp")}</p>
          <label className="field">
            <span>{t("account")}</span>
            <select
              value={accountId}
              disabled={busy || lines != null}
              onChange={(e) => setAccountId(Number(e.target.value))}
            >
              {usable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {lines == null ? (
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,.xls,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={busy}
              onChange={(e) => e.target.files?.[0] && read(e.target.files[0])}
            />
          ) : (
            <div className="form-actions">
              <span className="muted small">
                {format === "revolut" ? "Revolut · " : ""}
                {t("statementCounts", {
                  total: lines.length,
                  fresh: lines.filter((l) => !l.duplicate && !l.skip && !l.closed).length,
                  dup: lines.filter((l) => l.duplicate).length,
                })}
              </span>
              <span className="spacer" />
              <button className="btn" onClick={() => setLines(null)}>
                {t("statementOther")}
              </button>
            </div>
          )}
          {busy && <p className="muted">{t("loading")}</p>}
          {error && <p className="error">{error}</p>}
          {done && <p className="notice">{done}</p>}
        </div>
      </Section>

      {lines && (
        <Section
          title={t("statementReview")}
          action={
            <div className="segmented">
              <button className={onlyNew ? "active" : ""} onClick={() => setOnlyNew(true)}>
                {t("statementOnlyNew")}
              </button>
              <button className={onlyNew ? "" : "active"} onClick={() => setOnlyNew(false)}>
                {t("statementAll")}
              </button>
            </div>
          }
        >
          <p className="muted small">{t("statementReviewHelp", { account: account.name })}</p>
          <div className="toolbar">
            <button className="btn small-btn" onClick={() => setLines(lines.map((l) => ({ ...l, use: !l.duplicate && !l.skip && !l.closed })))}>
              {t("statementSelectNew")}
            </button>
            <button className="btn small-btn" onClick={() => setLines(lines.map((l) => ({ ...l, use: false })))}>
              {t("statementSelectNone")}
            </button>
          </div>
          <ul className="list statement">
            {shown.map(({ l, i }) => {
              const kind = l.amountCents < 0 ? "expense" : "income";
              return (
                <li key={i} className={l.use ? "" : "off"}>
                  <div className="statement-row">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={l.use}
                        disabled={l.closed}
                        aria-label={t("statementUse")}
                        onChange={(e) => update(i, { use: e.target.checked })}
                      />
                      <span className="list-main">
                        <strong>{l.description || "—"}</strong>
                        <span className="muted small">
                          {dateLabel(l.date, lang)}
                          {l.duplicate && <span className="pill warn"> {t("statementDuplicate")}</span>}
                          {l.closed && <span className="pill warn"> {t("monthClosed")}</span>}
                          {l.skip && <span className="pill warn"> {t(SKIP[l.skip])}</span>}
                          {l.use && l.suggested && <span className="pill"> {t("statementSuggested")}</span>}
                        </span>
                      </span>
                    </label>
                    <Money cents={l.amountCents} signed />
                  </div>
                  {l.use && (
                    <select className="filter-select" value={l.as} onChange={(e) => update(i, { as: e.target.value, suggested: false })}>
                      <option value="">{t("noCategory")}</option>
                      <optgroup label={kind === "expense" ? t("expenses") : t("incomes")}>
                        {categories
                          .filter((c) => c.kind === kind && (!c.archived || `c:${c.id}` === l.as))
                          .map((c) => (
                            <option key={c.id} value={`c:${c.id}`}>
                              {c.name}
                            </option>
                          ))}
                      </optgroup>
                      {others.length > 0 && (
                        <optgroup label={t("transfer")}>
                          {others.map((a) => (
                            <option key={a.id} value={`t:${a.id}`}>
                              {t(kind === "expense" ? "statementTransferTo" : "statementTransferFrom", { account: a.name })}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {pots.length > 0 && (
                        <optgroup label={t("navSavings")}>
                          {pots.map((p) => (
                            <option key={p.id} value={`p:${p.id}`}>
                              {t(kind === "expense" ? "statementDepositTo" : "statementWithdrawFrom", { pot: p.name })}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label={t("statementLoanGroup")}>
                        {[...people.values()].map((p) => {
                          const owed = kind === "income" ? p.lent : p.borrowed;
                          return [
                            <option key={`n${p.name}`} value={`l:new:${p.name}`}>
                              {t(kind === "income" ? "statementLoanFrom" : "statementLoanTo", { person: p.name })}
                            </option>,
                            (owed > 0 || l.as === `l:repay:${p.name}`) && (
                              <option key={`r${p.name}`} value={`l:repay:${p.name}`}>
                                {t(kind === "income" ? "statementRepaidBy" : "statementRepaidTo", { person: p.name })}
                              </option>
                            ),
                          ];
                        })}
                        <option value="l:other">{t(kind === "income" ? "statementLoanFromOther" : "statementLoanToOther")}</option>
                      </optgroup>
                    </select>
                  )}
                  {l.use && l.as === "l:other" && (
                    <input
                      className="search"
                      maxLength={80}
                      placeholder={t("statementPersonName")}
                      value={l.person}
                      onChange={(e) => update(i, { person: e.target.value })}
                    />
                  )}
                </li>
              );
            })}
          </ul>
          {hidden > 0 && <p className="muted small">{t("statementHidden", { n: hidden })}</p>}
          <div className="section-foot">
            <span className="muted small">
              {t("statementSelected", { n: chosen.length })} · <Money cents={outCents} signed /> · <Money cents={inCents} signed />
            </span>
            <button className="btn primary" disabled={busy || chosen.length === 0} onClick={save}>
              {t("statementImport", { n: chosen.length })}
            </button>
          </div>
        </Section>
      )}
    </div>
  );
}
