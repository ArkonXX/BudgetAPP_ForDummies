import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "./api";
import { useApp } from "./App";
import { useI18n, type Key } from "./i18n";
import { dateLabel } from "./format";
import { Modal, Money } from "./components";
import TransactionForm from "./TransactionForm";
import type { ToConfirm } from "../shared/types";

// Where to look at something that isn't an entry.
const PAGE: Record<ToConfirm["type"], string> = {
  entry: "/entries",
  transfer: "/accounts",
  savings: "/savings",
  loan: "/loans",
  repayment: "/loans",
};

/**
 * Things dated ahead (entries, transfers, savings, money to or from people)
 * don't count until their day. Once it comes, this asks whether each one
 * really went through: yes counts it on its date; not yet leaves an expense
 * still to pay and asks about anything else tomorrow. Shown when the app
 * opens and whenever it comes back to the screen.
 */
export default function ConfirmScheduled({ onChanged }: { onChanged: () => void }) {
  const { t, lang } = useI18n();
  const { categories, accounts } = useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState<ToConfirm[]>([]);
  const [later, setLater] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<ToConfirm | null>(null);

  const load = useCallback(() => {
    api
      .get<ToConfirm[]>("/to-confirm")
      .then(setItems)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  const id = (x: ToConfirm) => `${x.type}:${x.key}`;
  const answer = async (x: ToConfirm, done: boolean) => {
    setBusy(id(x));
    try {
      await api.post("/to-confirm", { type: x.type, key: x.key, done });
      setItems((xs) => xs.filter((y) => id(y) !== id(x)));
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  if (editing?.entry)
    return (
      <TransactionForm
        initial={editing.entry}
        onClose={() => setEditing(null)}
        onSaved={() => {
          load();
          onChanged();
        }}
      />
    );
  if (later || items.length === 0) return null;

  const accountName = (a: number | null) => accounts.find((x) => x.id === a)?.name ?? "";
  const title = (x: ToConfirm) => {
    switch (x.type) {
      case "entry":
        return x.label || categories.find((c) => c.id === x.entry?.categoryId)?.name || t("noCategory");
      case "transfer":
        return `${accountName(x.fromAccountId)} → ${accountName(x.toAccountId)}`;
      case "savings":
        return x.label;
      case "loan":
        return t(x.amountCents > 0 ? "statementLoanFrom" : "statementLoanTo", { person: x.person ?? "" });
      case "repayment":
        return t(x.amountCents > 0 ? "statementRepaidBy" : "statementRepaidTo", { person: x.person ?? "" });
    }
  };
  const doneLabel = (x: ToConfirm): Key =>
    x.type === "transfer" ? "confirmMade" : x.amountCents < 0 ? "confirmDebited" : "confirmReceived";
  const manyAccounts = accounts.length > 1;

  return (
    <Modal title={t("confirmTitle")} onClose={() => setLater(true)}>
      <p className="muted small">{t("confirmHelp")}</p>
      <ul className="confirm-list">
        {items.map((x) => (
          <li key={id(x)}>
            <div className="confirm-row">
              <div className="list-main">
                <strong>{title(x)}</strong>
                <span className="muted small">
                  {dateLabel(x.date, lang)}
                  {manyAccounts && x.accountId ? ` · ${accountName(x.accountId)}` : ""}
                  {x.type !== "entry" && x.type !== "savings" && x.label ? ` · ${x.label}` : ""}
                </span>
              </div>
              {x.type === "transfer" ? <Money cents={x.amountCents} /> : <Money cents={x.amountCents} signed />}
            </div>
            <div className="form-actions">
              <button className="btn primary small-btn" disabled={busy === id(x)} onClick={() => answer(x, true)}>
                {t(doneLabel(x))}
              </button>
              <button className="btn small-btn" disabled={busy === id(x)} onClick={() => answer(x, false)}>
                {t("confirmNotYet")}
              </button>
              {x.entry ? (
                <button className="btn small-btn" disabled={busy === id(x)} onClick={() => setEditing(x)}>
                  {t("edit")}
                </button>
              ) : (
                <button
                  className="btn small-btn"
                  onClick={() => {
                    setLater(true);
                    navigate(PAGE[x.type]);
                  }}
                >
                  {t("confirmOpen")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">{t("confirmNotYetHelp")}</p>
      <div className="form-actions">
        <span className="spacer" />
        <button className="btn" onClick={() => setLater(true)}>
          {t("confirmLater")}
        </button>
      </div>
    </Modal>
  );
}
