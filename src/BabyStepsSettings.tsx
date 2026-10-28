import { useEffect, useState } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import { MoneyField, Section } from "./components";
import type { BabyStepSettings, SavingsPot } from "../shared/types";

type Data = { settings: BabyStepSettings; pots: SavingsPot[] };

/** Targets used to work out the Baby Steps shown on the Plan page. */
export default function BabyStepsSettings() {
  const { t } = useI18n();
  const [pots, setPots] = useState<SavingsPot[]>([]);
  const [form, setForm] = useState<BabyStepSettings | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    api.get<Data>("/baby-steps/settings").then((d) => {
      setPots(d.pots);
      setForm(d.settings);
    });
  }, []);

  if (!form) return null;
  const set = (patch: Partial<BabyStepSettings>) => {
    setForm({ ...form, ...patch });
    setMessage(null);
  };
  const potSelect = (value: number | null, emptyLabel: string, onChange: (id: number | null) => void) => (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{emptyLabel}</option>
      {pots.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
  const save = async () => {
    setForm(await api.put<BabyStepSettings>("/baby-steps/settings", form));
    setMessage(t("saved_"));
  };

  return (
    <Section title={t("babySteps")}>
      <div className="form">
        <p className="muted small">{t("babySettingsHelp")}</p>
        <label className="field">
          <span>{t("emergencyPot")}</span>
          {potSelect(form.emergencyPotId, t("autoEmergencyPot"), (id) => set({ emergencyPotId: id }))}
        </label>
        <MoneyField label={t("starterFund")} cents={form.starterFundCents} onChange={(c) => set({ starterFundCents: c ?? 0 })} />
        <label className="field">
          <span>{t("emergencyMonths")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={24}
            value={form.emergencyMonths}
            onChange={(e) => set({ emergencyMonths: Math.min(24, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </label>
        <label className="field">
          <span>{t("investPercent")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            value={form.investPercent}
            onChange={(e) => set({ investPercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })}
          />
        </label>
        <label className="field">
          <span>{t("educationPot")}</span>
          {potSelect(form.educationPotId, t("noPot"), (id) => set({ educationPotId: id }))}
        </label>
        <div className="form-actions">
          {message && <span className="muted small">{message}</span>}
          <span className="spacer" />
          <button className="btn primary" onClick={save}>
            {t("save")}
          </button>
        </div>
      </div>
    </Section>
  );
}
