import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import * as inv from "./investments.ts";

test("average cost, value at the quote and gain on what was sold", () => {
  const db = openDb(":memory:");
  const id = inv.saveInvestment(db, { ticker: "VWCE", name: "Vanguard FTSE All-World", kind: "etf", quote: null, quoteDate: null });
  inv.saveTrade(db, { investmentId: id, date: "2026-01-10", side: "buy", quantity: 10, totalCents: 100000, note: "" });
  // The first buy sets the quote.
  assert.equal(inv.portfolio(db).investments[0].quote, 100);
  inv.saveTrade(db, { investmentId: id, date: "2026-02-10", side: "buy", quantity: 10, totalCents: 120000, note: "" });
  inv.saveTrade(db, { investmentId: id, date: "2026-03-10", side: "sell", quantity: 5, totalCents: 65000, note: "" });
  inv.saveInvestment(db, { id, ticker: "VWCE", name: "Vanguard FTSE All-World", kind: "etf", quote: 130, quoteDate: "2026-10-29" });

  const p = inv.portfolio(db);
  const h = p.investments[0];
  assert.equal(h.quantity, 15);
  assert.equal(h.averageCost, 110);
  assert.equal(h.costCents, 165000);
  assert.equal(h.valueCents, 195000);
  assert.equal(h.gainCents, 30000);
  assert.equal(h.realizedCents, 10000); // sold 5 at 130 that cost 110 each
  assert.equal(h.quoteDate, "2026-10-29");
  assert.equal(p.valueCents, 195000);
  assert.equal(h.trades[0].side, "sell");
});

test("can't sell more than is held, nor delete the buy a sale depends on", () => {
  const db = openDb(":memory:");
  const id = inv.saveInvestment(db, { ticker: "BTC", name: "", kind: "crypto", quote: 50000, quoteDate: "2026-10-01" });
  const buy = inv.saveTrade(db, { investmentId: id, date: "2026-01-01", side: "buy", quantity: 0.01, totalCents: 40000, note: "" });
  assert.throws(
    () => inv.saveTrade(db, { investmentId: id, date: "2026-02-01", side: "sell", quantity: 0.02, totalCents: 1, note: "" }),
    /sell_more_than_held/,
  );
  // A sale dated before the buy is refused too.
  assert.throws(
    () => inv.saveTrade(db, { investmentId: id, date: "2025-12-01", side: "sell", quantity: 0.01, totalCents: 1, note: "" }),
    /sell_more_than_held/,
  );
  inv.saveTrade(db, { investmentId: id, date: "2026-02-01", side: "sell", quantity: 0.01, totalCents: 45000, note: "" });
  assert.throws(() => inv.deleteTrade(db, buy), /sell_more_than_held/);
  const h = inv.portfolio(db).investments[0];
  assert.equal(h.quantity, 0);
  assert.equal(h.valueCents, 0);
  assert.equal(h.realizedCents, 5000);
});
