// Closing a budget month locks it: what it ended with is kept, and nothing
// dated in it can change until it is reopened. No money moves between months:
// the leftover is already in the accounts, whose balances go on by themselves.
// Closing is also when the account balances are checked against the bank.
import type { DB } from "./db.ts";
import { tx } from "./db.ts";
import { getClose, listAccounts } from "./store.ts";
import { monthSummary } from "./reports.ts";
import { todayISO } from "../shared/period.ts";
import type { MonthClose } from "../shared/types.ts";

export class CloseError extends Error {}

/**
 * Closes a month. `balances` is what the bank shows now for some accounts; a
 * difference from the app is recorded as an adjustment, which changes the
 * account's balance but not the budget.
 */
export function closeMonth(
  db: DB,
  month: string,
  balances: { accountId: number; bankCents: number }[] = [],
  today = todayISO(),
): MonthClose {
  return tx(db, () => {
    const summary = monthSummary(db, month, today);
    if (!summary.canClose) throw new CloseError("cannot_close");
    db.prepare("INSERT INTO month_closes (month, closed_at, balance_cents, action) VALUES (?, ?, ?, 'none')").run(
      month,
      today,
      summary.balanceCents,
    );
    const accounts = listAccounts(db);
    for (const b of balances) {
      const account = accounts.find((a) => a.id === b.accountId);
      if (!account) throw new CloseError("invalid accountId");
      const diff = b.bankCents - account.balanceCents;
      if (diff)
        db.prepare("INSERT INTO account_adjustments (account_id, date, amount_cents, close_month) VALUES (?, ?, ?, ?)").run(
          account.id,
          today,
          diff,
          month,
        );
    }
    return getClose(db, month)!;
  });
}

/** Unlocks a closed month. Balance adjustments stay: they match what the bank showed (so does pot money from older closes). */
export function reopenMonth(db: DB, month: string): void {
  if (!getClose(db, month)) throw new CloseError("not_closed");
  tx(db, () => {
    db.prepare("UPDATE account_adjustments SET close_month = NULL WHERE close_month = ?").run(month);
    db.prepare("DELETE FROM month_closes WHERE month = ?").run(month);
  });
}
