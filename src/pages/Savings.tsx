import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useApp } from "../App";
import { useI18n } from "../i18n";
import { dateLabel, money } from "../format";
import { Loading, Modal, Money, MoneyField, Progress, ScheduledHint, ScheduledTag, Section, useLoad } from "../components";
import { todayISO } from "../../shared/period";
import type { SavingsMovement, SavingsPot } from "../../shared/types";

type Data = { pots: SavingsPot[]; movements: SavingsMovement[] };

function PotForm({ pot, onClose, onSaved }: { pot?: SavingsPot; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(pot?.name ?? "");
  const [goal, setGoal] = useState<number | null>(pot?.goalCents ?? 0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await api.post("/savings/pots", { id: pot?.id, name, goalCents: goal ?? 0, sort: pot?.sort ?? 99 });
    onSaved();
    onClose();
  };
  const remove = async () => {
    if (!pot || !confirm(t("confirmDelete"))) return;
    await api.del(`/savings/pots/${pot.id}`);
    onSaved();
    onClose();
  };
  return (
    <Modal title={pot ? pot.name : t("newPot")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("name")}</span>
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <MoneyField label={t("goal")} cents={goal} onChange={setGoal} />
        <div className="form-actions">
          {pot && (
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

function MovementForm({
  pots,
  initial,
  potId,
  withdraw,
  onClose,
  onSaved,
}: {
  pots: SavingsPot[];
  initial?: SavingsMovement;
  potId: number;
  withdraw: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { accounts } = useApp();
  const [pot, setPot] = useState(initial?.potId ?? potId);
  const [accountId, setAccountId] = useState<number | null>(
    initial ? initial.accountId : (accounts.find((a) => a.isDefault)?.id ?? null),
  );
  const accountOptions = accounts.filter((a) => !a.archived || a.id === accountId);
  const [out, setOut] = useState(initial ? initial.amountCents < 0 : withdraw);
  const [amount, setAmount] = useState<number | null>(initial ? Math.abs(initial.amountCents) : null);
  const [date, setDate] = useState(initial?.date ?? todayISO());
  const [place, setPlace] = useState(initial?.place ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (amount == null || amount <= 0) {
      setError(t("invalidAmount"));
      return;
    }
    await api.post("/savings/movements", {
      id: initial?.id,
      potId: pot,
      date,
      amountCents: out ? -amount : amount,
      place,
      note,
      opening: initial?.opening ?? false,
      accountId: initial?.opening ? null : accountId,
    });
    onSaved();
    onClose();
  };
  const remove = async () => {
    if (!initial || !confirm(t("confirmDelete"))) return;
    await api.del(`/savings/movements/${initial.id}`);
    onSaved();
    onClose();
  };

  return (
    <Modal title={out ? t("withdraw") : t("deposit")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="segmented">
          <button type="button" className={!out ? "active" : ""} onClick={() => setOut(false)}>
            {t("deposit")}
          </button>
          <button type="button" className={out ? "active" : ""} onClick={() => setOut(true)}>
            {t("withdraw")}
          </button>
        </div>
        <label className="field">
          <span>{t("pots")}</span>
          <select value={pot} onChange={(e) => setPot(Number(e.target.value))}>
            {pots.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <MoneyField label={t("amount")} cents={amount} onChange={setAmount} autoFocus={!initial} />
        {!initial?.opening && (
          <label className="field">
            <span>{out ? t("toAccount") : t("fromAccount")}</span>
            <select value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)}>
              {accountOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
              <option value="">{t("noAccount")}</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>{t("date")}</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <ScheduledHint date={date} />
        <label className="field">
          <span>{t("place")}</span>
          <input maxLength={80} value={place} onChange={(e) => setPlace(e.target.value)} />
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

export default function Savings() {
  const { t, lang } = useI18n();
  const { accounts } = useApp();
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const { data, error, reload } = useLoad(() => api.get<Data>("/savings"), []);
  const [potForm, setPotForm] = useState<SavingsPot | "new" | null>(null);
  const [moveForm, setMoveForm] = useState<{ potId: number; withdraw: boolean; initial?: SavingsMovement } | null>(null);

  if (!data) return <Loading error={error} />;
  const total = data.pots.reduce((a, p) => a + p.balanceCents, 0);
  const potName = new Map(data.pots.map((p) => [p.id, p.name]));

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("navSavings")}</h1>
        <button className="btn" onClick={() => setPotForm("new")}>
          + {t("newPot")}
        </button>
      </header>
      <div className="card hero">
        <span className="muted">{t("totalSavings")}</span>
        <div className="hero-value">{money(total, lang)}</div>
      </div>

      <div className="pots">
        {data.pots.map((p) => (
          <div className="card pot" key={p.id}>
            <button className="pot-name" onClick={() => setPotForm(p)}>
              {p.name}
            </button>
            <strong className="num pot-balance">{money(p.balanceCents, lang)}</strong>
            {p.goalCents > 0 && (
              <>
                <Progress actual={p.balanceCents} planned={p.goalCents} inverse />
                <span className="muted small">
                  {t("ofGoal", { pct: Math.round((p.balanceCents / p.goalCents) * 100) })} · {money(p.goalCents, lang)}
                </span>
              </>
            )}
            <div className="pot-actions">
              <button className="btn small-btn" onClick={() => setMoveForm({ potId: p.id, withdraw: false })}>
                + {t("deposit")}
              </button>
              <button className="btn small-btn" onClick={() => setMoveForm({ potId: p.id, withdraw: true })}>
                − {t("withdraw")}
              </button>
            </div>
          </div>
        ))}
      </div>

      <Section title={t("movements")}>
        {data.movements.length === 0 ? (
          <p className="muted">{t("nothingYet")}</p>
        ) : (
          <ul className="list">
            {data.movements.map((m) => (
              <li key={m.id}>
                <button className="list-row" onClick={() => setMoveForm({ potId: m.potId, withdraw: m.amountCents < 0, initial: m })}>
                  <div className="list-main">
                    <strong>{potName.get(m.potId)}</strong>
                    <span className="muted small">
                      {dateLabel(m.date, lang)}
                      {m.opening ? ` · ${t("openingBalance")}` : ""}
                      {m.accountId ? ` · ${accountName.get(m.accountId) ?? ""}` : m.place ? ` · ${m.place}` : ""}
                      {m.note && !m.opening ? ` · ${m.note}` : ""}
                      {m.scheduled && <ScheduledTag date={m.date} />}
                    </span>
                  </div>
                  <Money cents={m.amountCents} signed />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {potForm && <PotForm pot={potForm === "new" ? undefined : potForm} onClose={() => setPotForm(null)} onSaved={reload} />}
      {moveForm && data.pots.length > 0 && (
        <MovementForm
          pots={data.pots}
          potId={moveForm.potId}
          withdraw={moveForm.withdraw}
          initial={moveForm.initial}
          onClose={() => setMoveForm(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
