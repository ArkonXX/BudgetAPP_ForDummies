import { useRef, useState } from "react";
import { api, ApiError } from "./api";
import { useI18n, type Key } from "./i18n";
import { Loading, Section, useLoad } from "./components";
import type { BackupFile, BackupReason } from "../shared/types";

type Data = { enabled: boolean; dir: string | null; backups: BackupFile[] };

const REASON: Record<BackupReason, Key> = {
  daily: "backupDaily",
  "before-import": "backupBeforeImport",
  "before-wipe": "backupBeforeWipe",
  "before-restore": "backupBeforeRestore",
};

/** Copies kept on the server: download one, or put one back. */
export default function BackupSettings() {
  const { t, lang } = useI18n();
  const { data, error, reload } = useLoad(() => api.get<Data>("/backups"), []);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const when = (b: BackupFile) =>
    new Intl.DateTimeFormat(lang === "pt" ? "pt-PT" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(b.createdAt));
  const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

  // Everything on screen may have changed, so the whole app is loaded again.
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      window.location.reload();
    } catch (e) {
      setMessage({ ok: false, text: e instanceof ApiError && e.code === "not_a_backup" ? t("restoreNotBackup") : t("error") });
      setBusy(false);
      reload();
    }
  };
  const restore = (b: BackupFile) => {
    if (!confirm(t("restoreConfirm", { date: when(b) }))) return;
    run(() => api.post(`/backups/${encodeURIComponent(b.name)}/restore`, {}));
  };
  const restoreFile = (file: File) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!confirm(t("restoreConfirm", { date: file.name }))) return;
    run(() => api.upload("/restore", file));
  };

  const list = data?.backups ?? [];
  const shown = showAll ? list : list.slice(0, 5);

  return (
    <Section title={t("backupTitle")}>
      <p className="muted small">{t("backupHelp")}</p>
      <a className="btn" href="/api/backup" download>
        {t("downloadBackup")}
      </a>
      {!data ? (
        <Loading error={error} />
      ) : (
        data.enabled && (
          <>
            <h3 className="backup-kept">{t("backupKept")}</h3>
            <p className="muted small">{t("backupKeptHelp", { dir: data.dir ?? "" })}</p>
            {list.length === 0 ? (
              <p className="muted small">{t("backupNone")}</p>
            ) : (
              <ul className="list">
                {shown.map((b) => (
                  <li key={b.name} className="list-row static backup-row">
                    <div className="list-main">
                      <strong>{when(b)}</strong>
                      <span className="muted small">
                        {t(REASON[b.reason])} · {size(b.sizeBytes)}
                      </span>
                    </div>
                    <a className="btn small-btn" href={`/api/backups/${encodeURIComponent(b.name)}`} download aria-label={t("downloadBackup")}>
                      ↓
                    </a>
                    <button className="btn small-btn" disabled={busy} onClick={() => restore(b)}>
                      {t("restore")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {list.length > 5 && (
              <button className="btn small-btn" onClick={() => setShowAll(!showAll)}>
                {showAll ? t("showLess") : t("showAllCount", { n: list.length })}
              </button>
            )}
            <label className="field">
              <span>{t("restoreFromFile")}</span>
              <input ref={fileRef} type="file" accept=".db,.sqlite,application/vnd.sqlite3" disabled={busy} onChange={(e) => e.target.files?.[0] && restoreFile(e.target.files[0])} />
            </label>
          </>
        )
      )}
      {busy && <p className="muted">{t("loading")}</p>}
      {message && <p className={message.ok ? "notice" : "error"}>{message.text}</p>}
    </Section>
  );
}
