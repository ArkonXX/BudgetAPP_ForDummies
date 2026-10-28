// Closing a budget month, like turning the page on the spreadsheet: the
// month's leftover goes on to the next month or into a savings pot (or a
// shortfall is carried or covered from a pot), account balances are set to
// what the bank shows, and the month's entries can no longer change.
// Reopening undoes all of it.
import type { DB } from "./db.ts";
import { tx } from "./db.ts";
import { getClose, listAccounts, listPots, saveMovement } from "./store.ts";
import { monthSummary } from "./reports.ts";
import { addMonths, todayISO } from "../shared/period.ts";
import type { CloseAction, MonthClose } from "../shared/types.ts";

export class CloseError extends Error {}

export interface CloseInput {
  month: string;
  action: CloseAction;
  potId: number | null;
  potCents: number; // how much of the leftover (or shortfall) the pot takes; the rest is carried
  accountId: number | null; // the account the pot money leaves (or comes into); null = none
  balances: { accountId: number; bankCents: number }[]; // what the bank shows now
}

/** The day before an exclusive end date. */
function lastDay(to: string): string {
  return new Date(Date.parse(to) - 86400_000).toISOString().slice(0, 10);
}

export function closeMonth(db: DB, input: CloseInput, today = todayISO()): MonthClose {
  return tx(db, () => {
    const summary = monthSummary(db, input.month, today);
    if (!summary.canClose) throw new CloseError("cannot_close");
    const balance = summary.balanceCents;
    db.prepare("INSERT INTO month_closes (month, closed_at, balance_cents, action) VALUES (?, ?, ?, 'none')").run(
      input.month,
      today,
      balance,
    );

    // Against the balances shown before closing, i.e. before any money goes to a pot.
    const accounts = listAccounts(db);
    for (const b of input.balances) {
      const account = accounts.find((a) => a.id === b.accountId);
      if (!account) throw new CloseError("invalid accountId");
      const diff = b.bankCents - account.balanceCents;
      if (diff)
        db.prepare("INSERT INTO account_adjustments (account_id, date, amount_cents, close_month) VALUES (?, ?, ?, ?)").run(
          account.id,
          today,
          diff,
          input.month,
        );
    }

    let action: CloseAction = input.action;
    let potCents = 0;
    let movementId: number | null = null;
    let carry = action === "carry" ? balance : 0;
    if (action === "pot" && balance === 0) action = "none";
    if (action === "pot") {
      const pot = listPots(db).find((p) => p.id === input.potId);
      if (!pot) throw new CloseError("invalid potId");
      potCents = input.potCents;
      if (potCents < 1 || potCents > Math.abs(balance)) throw new CloseError("invalid potCents");
      if (balance < 0 && potCents > pot.balanceCents) throw new CloseError("pot_too_small");
      // On the month's last day, so a leftover saved counts as that month's savings.
      movementId = saveMovement(db, {
        potId: pot.id,
        date: lastDay(summary.to),
        amountCents: balance > 0 ? potCents : -potCents,
        place: "",
        note: `${balance > 0 ? "Sobra" : "Falta"} ${input.month}`,
        opening: false,
        accountId: input.accountId,
      });
      // What the pot doesn't take is carried on.
      carry = balance > 0 ? balance - potCents : balance + potCents;
    }
    db.prepare(
      "UPDATE month_closes SET action = ?, pot_id = ?, pot_cents = ?, movement_id = ?, carry_cents = ? WHERE month = ?",
    ).run(action, action === "pot" ? input.potId : null, potCents, movementId, carry, input.month);
    return getClose(db, input.month)!;
  });
}

/** Opens a closed month again; only the last closed one, as the next month counts on it. */
export function reopenMonth(db: DB, month: string): void {
  if (!getClose(db, month)) throw new CloseError("not_closed");
  if (getClose(db, addMonths(month, 1))) throw new CloseError("next_closed");
  tx(db, () => {
    const row = db.prepare("SELECT movement_id FROM month_closes WHERE month = ?").get(month) as { movement_id: number | null };
    if (row.movement_id != null) db.prepare("DELETE FROM savings_movements WHERE id = ?").run(row.movement_id);
    // Its balance adjustments go with it (ON DELETE CASCADE).
    db.prepare("DELETE FROM month_closes WHERE month = ?").run(month);
  });
}
