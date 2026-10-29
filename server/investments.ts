// The investment portfolio, like the spreadsheet's Investimentos and
// Transacoes sheets: holdings are worked out from their buys and sells, at
// average cost, and valued at the last quote typed in.
import type { DB } from "./db.ts";
import type { Investment, InvestmentKind, InvestmentTrade, Portfolio, TradeSide } from "../shared/types.ts";

export class InvestmentError extends Error {}

type TradeRow = { id: number; investment_id: number; date: string; side: TradeSide; quantity: number; total_cents: number; note: string };
type InvestmentRow = { id: number; ticker: string; name: string; kind: InvestmentKind; quote: number | null; quote_date: string | null };

// Quantities are fractional (crypto, fractional shares); below this they count as zero.
const EPSILON = 1e-9;

/** Runs through the trades oldest first. Throws when a sale is bigger than what was held on that day. */
export function position(trades: Pick<InvestmentTrade, "date" | "side" | "quantity" | "totalCents">[]) {
  let quantity = 0;
  let cost = 0;
  let realized = 0;
  const ordered = [...trades].sort((a, b) => a.date.localeCompare(b.date) || (a.side === b.side ? 0 : a.side === "buy" ? -1 : 1));
  for (const t of ordered) {
    if (t.side === "buy") {
      quantity += t.quantity;
      cost += t.totalCents;
    } else {
      if (t.quantity > quantity + EPSILON) throw new InvestmentError("sell_more_than_held");
      const soldCost = quantity > 0 ? (cost * t.quantity) / quantity : 0;
      realized += t.totalCents - soldCost;
      cost -= soldCost;
      quantity -= t.quantity;
      if (quantity < EPSILON) {
        quantity = 0;
        cost = 0;
      }
    }
  }
  return { quantity, costCents: Math.round(cost), realizedCents: Math.round(realized) };
}

const toTrade = (r: TradeRow): InvestmentTrade => ({
  id: Number(r.id),
  investmentId: Number(r.investment_id),
  date: r.date,
  side: r.side,
  quantity: r.quantity,
  totalCents: r.total_cents,
  note: r.note,
});

export function portfolio(db: DB): Portfolio {
  const rows = db.prepare("SELECT * FROM investments ORDER BY sort, ticker COLLATE NOCASE, id").all() as InvestmentRow[];
  const trades = (db.prepare("SELECT * FROM investment_trades ORDER BY date DESC, id DESC").all() as TradeRow[]).map(toTrade);
  const investments: Investment[] = rows.map((r) => {
    const own = trades.filter((t) => t.investmentId === Number(r.id));
    const p = position(own);
    const valueCents = r.quote == null ? p.costCents : Math.round(p.quantity * r.quote * 100);
    return {
      id: Number(r.id),
      ticker: r.ticker,
      name: r.name,
      kind: r.kind,
      quote: r.quote,
      quoteDate: r.quote_date,
      quantity: p.quantity,
      costCents: p.costCents,
      averageCost: p.quantity > 0 ? p.costCents / 100 / p.quantity : null,
      valueCents,
      gainCents: valueCents - p.costCents,
      realizedCents: p.realizedCents,
      trades: own,
    };
  });
  const sum = (f: (i: Investment) => number) => investments.reduce((s, i) => s + f(i), 0);
  return {
    investments,
    valueCents: sum((i) => i.valueCents),
    costCents: sum((i) => i.costCents),
    gainCents: sum((i) => i.gainCents),
    realizedCents: sum((i) => i.realizedCents),
  };
}

export function saveInvestment(
  db: DB,
  i: { id?: number; ticker: string; name: string; kind: InvestmentKind; quote: number | null; quoteDate: string | null },
): number {
  if (i.id) {
    const old = db.prepare("SELECT quote FROM investments WHERE id = ?").get(i.id) as { quote: number | null } | undefined;
    if (!old) throw new InvestmentError("not_found");
    // The quote's date only moves when the quote itself changes.
    db.prepare(
      "UPDATE investments SET ticker = ?, name = ?, kind = ?, quote = ?, quote_date = CASE WHEN quote IS ? THEN quote_date ELSE ? END WHERE id = ?",
    ).run(i.ticker, i.name, i.kind, i.quote, i.quote, i.quote == null ? null : i.quoteDate, i.id);
    return i.id;
  }
  const r = db
    .prepare("INSERT INTO investments (ticker, name, kind, quote, quote_date) VALUES (?, ?, ?, ?, ?)")
    .run(i.ticker, i.name, i.kind, i.quote, i.quote == null ? null : i.quoteDate);
  return Number(r.lastInsertRowid);
}

export function deleteInvestment(db: DB, id: number): void {
  db.prepare("DELETE FROM investments WHERE id = ?").run(id);
}

/** Saves a buy or sell. The holding must never go below zero; the first buy also sets the quote. */
export function saveTrade(
  db: DB,
  t: { id?: number; investmentId: number; date: string; side: TradeSide; quantity: number; totalCents: number; note: string },
): number {
  const inv = db.prepare("SELECT quote FROM investments WHERE id = ?").get(t.investmentId) as { quote: number | null } | undefined;
  if (!inv) throw new InvestmentError("not_found");
  const others = (db.prepare("SELECT * FROM investment_trades WHERE investment_id = ? AND id IS NOT ?").all(t.investmentId, t.id ?? null) as TradeRow[]).map(toTrade);
  position([...others, t]);
  let id = t.id;
  if (id) {
    const r = db
      .prepare("UPDATE investment_trades SET investment_id = ?, date = ?, side = ?, quantity = ?, total_cents = ?, note = ? WHERE id = ?")
      .run(t.investmentId, t.date, t.side, t.quantity, t.totalCents, t.note, id);
    if (r.changes === 0) throw new InvestmentError("not_found");
  } else {
    id = Number(
      db
        .prepare("INSERT INTO investment_trades (investment_id, date, side, quantity, total_cents, note) VALUES (?, ?, ?, ?, ?, ?)")
        .run(t.investmentId, t.date, t.side, t.quantity, t.totalCents, t.note).lastInsertRowid,
    );
  }
  if (inv.quote == null)
    db.prepare("UPDATE investments SET quote = ?, quote_date = ? WHERE id = ?").run(t.totalCents / 100 / t.quantity, t.date, t.investmentId);
  return id;
}

/** Deletes a trade, unless that would leave a later sale selling more than was held. */
export function deleteTrade(db: DB, id: number): void {
  const row = db.prepare("SELECT investment_id FROM investment_trades WHERE id = ?").get(id) as { investment_id: number } | undefined;
  if (!row) return;
  const rest = (db.prepare("SELECT * FROM investment_trades WHERE investment_id = ? AND id != ?").all(row.investment_id, id) as TradeRow[]).map(toTrade);
  position(rest);
  db.prepare("DELETE FROM investment_trades WHERE id = ?").run(id);
}
