import { useRef, useState } from "react";
import { api, ApiError } from "../api";
import { useApp } from "../App";
import { useI18n } from "../i18n";
import { dateLabel, money } from "../format";
import { monthOf, periodRange, todayISO } from "../../shared/period";
import { EXPENSE_GROUPS, Modal, MoneyField, Section, SpentFromSelect } from "../components";
import BabyStepsSettings from "../BabyStepsSettings";
import BackupSettings from "../BackupSettings";
import type { Category, ExpenseGroup, Kind } from "../../shared/types";

/** The day before an exclusive end date. */
function lastDay(exclusiveEnd: string): string {
  const d = new Date(`${exclusiveEnd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

type ImportReport = { transactions: number; categories: number; savingsMovements: number; planItems: number; loans: number; warnings: string[] };

function CategoryForm({ cat, kind, onClose, onSaved }: { cat?: Category; kind: Kind; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(cat?.name ?? "");
  const [planned, setPlanned] = useState<number | null>(cat?.plannedCents ?? 0);
  const [archived, setArchived] = useState(cat?.archived ?? false);
  const [group, setGroup] = useState<ExpenseGroup>(cat?.group ?? "variable");
  const [accountId, setAccountId] = useState<number | null>(cat?.accountId ?? null);
  const { accounts } = useApp();
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/categories", { id: cat?.id, kind, name, plannedCents: planned ?? 0, sort: cat?.sort ?? 999, archived, group: kind === "expense" ? group : undefined, accountId: kind === "expense" && group === "variable" ? accountId : null });
      onSaved();
      onClose();
    } catch {
      setError(t("error"));
    }
  };
  const remove = async () => {
    if (!cat || !confirm(t("confirmDelete"))) return;
    await api.del(`/categories/${cat.id}`);
    onSaved();
    onClose();
  };
  return (
    <Modal title={cat ? cat.name : t("newCategory")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("name")}</span>
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <MoneyField label={`${t("planned")} (${t("monthly").toLowerCase()})`} cents={planned} onChange={setPlanned} />
        {kind === "expense" && (
          <label className="field">
            <span>{t("expenseGroup")}</span>
            <select value={group} onChange={(e) => setGroup(e.target.value as ExpenseGroup)}>
              {EXPENSE_GROUPS.map((g) => (
                <option key={g.group} value={g.group}>
                  {t(g.label)}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "expense" && group === "variable" && accounts.length > 1 && (
          <label className="field">
            <span>{t("spentFrom")}</span>
            <SpentFromSelect value={accountId} onChange={setAccountId} />
            <small className="muted">{t("spentFromHelp")}</small>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          {t("archived")}
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          {cat && (
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

function WipeForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/wipe", { password });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "wrong_password" ? t("wrongPassword") : t("error"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={t("wipeTitle")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="error">{t("wipeWarning")}</p>
        <a className="btn" href="/api/backup" download>
          {t("downloadBackup")}
        </a>
        <label className="field">
          <span>{t("wipePassword")}</span>
          <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn danger" disabled={busy || !password}>
            {t("wipeConfirm")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function SettingsPage() {
  const { t, lang, setLang } = useI18n();
  const { settings, categories, refresh, logout } = useApp();
  const [startMode, setStartMode] = useState(settings.monthStartMode);
  const [startDay, setStartDay] = useState(settings.monthStartDay);
  const [plannedSavings, setPlannedSavings] = useState<number | null>(settings.plannedSavingsCents);
  const [message, setMessage] = useState<string | null>(null);
  const [catForm, setCatForm] = useState<{ kind: Kind; cat?: Category } | null>(null);
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string; warnings?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeMsg, setWipeMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Preview of the current budget month under the choice being edited.
  const start = startMode === "fixedDay" ? startDay : "lastBusinessDay";
  const period = periodRange(monthOf(todayISO(), start), start);

  const saveGeneral = async () => {
    await api.put("/settings", { monthStartMode: startMode, monthStartDay: startDay, plannedSavingsCents: plannedSavings ?? 0 });
    await refresh();
    setMessage(t("saved_"));
  };

  const onImport = async (file: File) => {
    if (!confirm(t("importConfirm"))) return;
    setBusy(true);
    setImportMsg(null);
    try {
      const r = await api.upload<ImportReport>("/import", file);
      setImportMsg({
        ok: true,
        text: t("importDone", { transactions: r.transactions, categories: r.categories, movements: r.savingsMovements, items: r.planItems, loans: r.loans }),
        warnings: r.warnings,
      });
      await refresh();
    } catch (e) {
      setImportMsg({ ok: false, text: `${t("error")} ${(e as Error).message}` });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("settingsTitle")}</h1>
        <button className="btn" onClick={logout}>
          {t("logout")}
        </button>
      </header>

      <div className="plan-grid">
        <Section title={t("language")}>
          <div className="segmented">
            <button className={lang === "pt" ? "active" : ""} onClick={() => setLang("pt")}>
              Português
            </button>
            <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
              English
            </button>
          </div>
        </Section>

        <Section title={t("navBudget")}>
          <div className="form">
            <div className="field">
              <span>{t("monthStart")}</span>
              <div className="segmented">
                {(["lastBusinessDay", "fixedDay"] as const).map((m) => (
                  <button key={m} type="button" className={startMode === m ? "active" : ""} onClick={() => setStartMode(m)}>
                    {m === "lastBusinessDay" ? t("monthStartLastBusinessDay") : t("monthStartFixedDay")}
                  </button>
                ))}
              </div>
              {startMode === "lastBusinessDay" && <small className="muted">{t("monthStartLastBusinessDayHelp")}</small>}
            </div>
            {startMode === "fixedDay" && (
              <label className="field">
                <span>{t("monthStartDay")}</span>
                <input type="number" inputMode="numeric" min={1} max={28} value={startDay} onChange={(e) => setStartDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))} />
                <small className="muted">{t("monthStartHelp")}</small>
              </label>
            )}
            <small className="muted">
              {t("currentPeriod", { from: dateLabel(period.from, lang), to: dateLabel(lastDay(period.to), lang) })}
            </small>
            <MoneyField label={t("plannedSavings")} cents={plannedSavings} onChange={setPlannedSavings} />
            <div className="form-actions">
              {message && <span className="muted small">{message}</span>}
              <span className="spacer" />
              <button className="btn primary" onClick={saveGeneral}>
                {t("save")}
              </button>
            </div>
          </div>
        </Section>

        {(["expense", "income"] as Kind[]).map((kind) => (
          <Section
            key={kind}
            title={`${t("categories")} · ${kind === "expense" ? t("expenses") : t("incomes")}`}
            action={
              <button className="btn small-btn" onClick={() => setCatForm({ kind })}>
                + {t("add")}
              </button>
            }
          >
            <ul className="list">
              {categories
                .filter((c) => c.kind === kind)
                .map((c) => (
                  <li key={c.id}>
                    <button className={`list-row ${c.archived ? "muted" : ""}`} onClick={() => setCatForm({ kind, cat: c })}>
                      <span>
                        {c.name}
                        {c.archived ? ` (${t("archived").toLowerCase()})` : ""}
                      </span>
                      <span className="num muted">{money(c.plannedCents, lang)}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </Section>
        ))}

        <BabyStepsSettings />

        <Section title={t("importTitle")}>
          <p className="muted small">{t("importHelp")}</p>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
          />
          {busy && <p className="muted">{t("loading")}</p>}
          {importMsg && (
            <div className={importMsg.ok ? "notice" : "error"}>
              <p>{importMsg.text}</p>
              {importMsg.warnings && importMsg.warnings.length > 0 && (
                <ul className="small">
                  {importMsg.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Section>

        <BackupSettings />

        <Section title={t("wipeTitle")}>
          <p className="muted small">{t("wipeHelp")}</p>
          <button className="btn danger" onClick={() => setWipeOpen(true)}>
            {t("wipeButton")}
          </button>
          {wipeMsg && <p className="notice">{wipeMsg}</p>}
        </Section>
      </div>

      {wipeOpen && (
        <WipeForm
          onClose={() => setWipeOpen(false)}
          onDone={async () => {
            await refresh();
            setWipeMsg(t("wipeDone"));
          }}
        />
      )}

      {catForm && <CategoryForm kind={catForm.kind} cat={catForm.cat} onClose={() => setCatForm(null)} onSaved={refresh} />}
    </div>
  );
}
