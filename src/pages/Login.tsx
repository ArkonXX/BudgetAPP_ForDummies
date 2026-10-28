import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { useI18n } from "../i18n";

export default function Login({ onLogin }: { onLogin: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/login", { password });
      onLogin();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setError(code === "too_many_attempts" ? t("tooManyAttempts") : code === "wrong_password" ? t("wrongPassword") : t("error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="login-logo" aria-hidden>
          €
        </div>
        <h1>{t("appName")}</h1>
        <label className="field">
          <span>{t("password")}</span>
          <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn primary block" disabled={busy || !password}>
          {t("login")}
        </button>
        <div className="lang-switch">
          <button type="button" className={lang === "pt" ? "active" : ""} onClick={() => setLang("pt")}>
            Português
          </button>
          <button type="button" className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
            English
          </button>
        </div>
      </form>
    </div>
  );
}
