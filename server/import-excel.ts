// Imports the "My Budget" workbook. Each section below reads one sheet and
// mirrors how the spreadsheet uses it:
//   Despesas / Entradas   -> transactions
//   Sumário               -> categories with their planned monthly amount
//   Poupanças / Poupancas -> savings pots, their balances and deposits
//   Main Dashboard        -> salary, fixed costs, subscriptions, investments,
//                            donations, annual costs and loans

import ExcelJS from "exceljs";
import type { DB } from "./db.ts";
import { tiePlanLines, tx } from "./db.ts";
import {
  ensureCategory,
  ensurePot,
  saveLoan,
  saveMovement,
  savePlanItem,
  saveTransaction,
  updateSettings,
} from "./store.ts";
import type { Kind, PlanSection } from "../shared/types.ts";

export interface ImportReport {
  transactions: number;
  categories: number;
  savingsMovements: number;
  planItems: number;
  loans: number;
  warnings: string[];
}

type Cell = ExcelJS.CellValue;

/** Resolves formulas to their cached result and rich text to plain text. */
function val(v: Cell): unknown {
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) return val((v as { result: Cell }).result);
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
    if ("text" in v) return (v as { text: string }).text;
    if ("error" in v) return undefined;
  }
  return v;
}

function text(v: Cell): string {
  const x = val(v);
  return x == null ? "" : String(x).trim();
}

function num(v: Cell): number | null {
  const x = val(v);
  if (typeof x === "number") return x;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const cents = (n: number) => Math.round(n * 100);

/** Accepts Excel dates and "d/m/yyyy" strings; returns "YYYY-MM-DD". */
function date(v: Cell): string | null {
  const x = val(v);
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  if (typeof x === "string") {
    const m = x.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const iso = x.trim().match(/^\d{4}-\d{2}-\d{2}/);
    if (iso) return iso[0];
  }
  return null;
}

/** Case- and accent-insensitive key, so "Saude" and "Saúde" are one category. */
const key = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const PT_MONTHS = [
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

function findSheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet | undefined {
  // Exact name first: "Poupanças" and "Poupancas" are different sheets.
  return (
    wb.worksheets.find((w) => w.name.trim() === name) ??
    wb.worksheets.find((w) => key(w.name) === key(name))
  );
}

function clearAll(db: DB) {
  db.exec(`
    DELETE FROM transactions; DELETE FROM installment_plans; DELETE FROM categories; DELETE FROM savings_movements;
    DELETE FROM savings_pots; DELETE FROM plan_items; DELETE FROM loan_amortizations;
    DELETE FROM loans;
  `);
}

export async function importWorkbook(db: DB, data: Buffer | ArrayBuffer): Promise<ImportReport> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as ArrayBuffer);
  const report: ImportReport = {
    transactions: 0,
    categories: 0,
    savingsMovements: 0,
    planItems: 0,
    loans: 0,
    warnings: [],
  };

  tx(db, () => {
    clearAll(db);
    const catIds = new Map<string, number>();
    const category = (kind: Kind, name: string, plannedCents = 0) => {
      const k = `${kind}:${key(name)}`;
      let id = catIds.get(k);
      if (id === undefined) {
        id = ensureCategory(db, kind, name, plannedCents);
        catIds.set(k, id);
        report.categories++;
      }
      return id;
    };

    // Main Dashboard: salary first, the budget's planned income depends on it.
    const dash = findSheet(wb, "Main Dashboard");
    const salary = dash ? num(dash.getCell("H7").value) : null;

    // Sumário: categories in the order the spreadsheet lists them.
    const sum = findSheet(wb, "Sumário");
    if (sum) {
      let section: Kind | null = null;
      sum.eachRow((row, r) => {
        const name = text(row.getCell(2).value);
        if (key(name) === "despesas" && r > 20) section = "expense";
        else if (key(name) === "rendimentos" && r > 20) section = "income";
        else if (!section || !name || key(name) === "total") return;
        else if (/^categoria \d+$/i.test(name) && !num(row.getCell(4).value)) return;
        else if (section === "expense" && key(name) === "poupancas") {
          const planned = num(row.getCell(4).value);
          if (planned) updateSettings(db, { plannedSavingsCents: cents(planned) });
        } else {
          category(section, name, cents(num(row.getCell(4).value) ?? 0));
        }
      });
    } else report.warnings.push("Sheet 'Sumário' not found: categories are created from the entries.");

    // Despesas and Entradas.
    const readEntries = (
      sheetName: string,
      kind: Kind,
      cols: { date: number; amount: number; desc: number; cat: number },
    ) => {
      const ws = findSheet(wb, sheetName);
      if (!ws) {
        report.warnings.push(`Sheet '${sheetName}' not found.`);
        return;
      }
      ws.eachRow((row, r) => {
        if (r === 1) return;
        const amount = num(row.getCell(cols.amount).value);
        const d = date(row.getCell(cols.date).value);
        if (amount == null && !d) return;
        if (amount == null || !d) {
          report.warnings.push(`${sheetName} row ${r}: skipped (missing date or amount).`);
          return;
        }
        const catName = text(row.getCell(cols.cat).value);
        saveTransaction(db, {
          kind,
          date: d,
          amountCents: cents(amount),
          description: text(row.getCell(cols.desc).value),
          categoryId: catName ? category(kind, catName) : null,
        });
        report.transactions++;
      });
    };
    readEntries("Despesas", "expense", { date: 3, amount: 4, desc: 5, cat: 6 });
    readEntries("Entradas", "income", { date: 2, amount: 3, desc: 4, cat: 5 });

    const potIds = new Map<string, number>();
    const pot = (name: string) => {
      let id = potIds.get(key(name));
      if (id === undefined) potIds.set(key(name), (id = ensurePot(db, name)));
      return id;
    };

    // Poupanças: one pot per "Mealheiro" row, opening with its latest balance.
    const pots = findSheet(wb, "Poupanças");
    if (pots) {
      // The 2025 table ("... - My Savings" rows) holds the newest balance (column "Saldo").
      const latest = new Map<string, number>();
      let saldoCol = 0;
      let lastDate = "";
      pots.eachRow((row, r) => {
        row.eachCell((c, col) => {
          if (key(text(c.value)) === "saldo" && r > 20) saldoCol = col;
          const d = date(c.value);
          if (d && d > lastDate) lastDate = d;
        });
        const name = text(row.getCell(2).value);
        if (saldoCol && / - /.test(name)) {
          const bal = num(row.getCell(saldoCol).value);
          if (bal != null) latest.set(key(name.split(" - ")[0]), bal);
        }
      });
      for (let r = 15; r <= 19; r++) {
        const name = text(pots.getCell(r, 2).value);
        if (!name) continue;
        const potId = pot(name);
        const match = [...latest.entries()].find(([k]) => k.includes(key(name).slice(0, 6)));
        const balance = match ? match[1] : num(pots.getCell(r, 9).value) ?? 0;
        if (balance) {
          saveMovement(db, {
            potId,
            date: lastDate || "2025-12-31",
            amountCents: cents(balance),
            place: "",
            note: "Saldo inicial (Excel)",
            opening: true,
          });
          report.savingsMovements++;
        }
      }
    }

    // Poupancas: individual deposits (2026 onwards), "Tipo" names the pot.
    const deposits = findSheet(wb, "Poupancas");
    if (deposits) {
      deposits.eachRow((row, r) => {
        if (r === 1) return;
        const d = date(row.getCell(2).value);
        const amount = num(row.getCell(3).value);
        if (!d || amount == null) return;
        const tipo = text(row.getCell(5).value) || "Poupanças";
        const potId = pot(tipo);
        saveMovement(db, {
          potId,
          date: d,
          amountCents: cents(amount),
          place: text(row.getCell(4).value),
          note: "",
          opening: false,
        });
        report.savingsMovements++;
      });
    }

    if (dash) {
      if (salary != null) updateSettings(db, { salaryCents: cents(salary) });
      // The salary lands on the last working day of the month (28/11, 31/12,
      // 30/01, 27/02 in the workbook), so each budget month starts on payday.
      updateSettings(db, { monthStartMode: "lastBusinessDay" });

      const items = (section: PlanSection, nameCol: string, amountCol: string, rows: number[], monthCol?: string) => {
        let sort = 0;
        for (const r of rows) {
          const name = text(dash.getCell(`${nameCol}${r}`).value);
          if (!name || key(name) === "total") continue;
          let month: number | null = null;
          if (monthCol) {
            const i = PT_MONTHS.indexOf(key(text(dash.getCell(`${monthCol}${r}`).value)));
            month = i >= 0 ? i + 1 : null;
          }
          savePlanItem(db, {
            section,
            name,
            amountCents: cents(num(dash.getCell(`${amountCol}${r}`).value) ?? 0),
            month,
            sort: sort++,
          });
          report.planItems++;
        }
      };
      const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
      items("fixed", "G", "H", range(13, 18));
      items("subscription", "K", "L", range(13, 19));
      items("investment", "O", "P", range(13, 14));
      items("donation", "K", "L", range(25, 26));
      items("annual", "G", "I", range(25, 28), "H");

      // Loans: columns W.. hold "Armortizações <year>" until the monthly column.
      const yearCols: { col: number; year: number }[] = [];
      for (let c = 23; c <= 30; c++) {
        const m = text(dash.getCell(12, c).value).match(/(\d{4})/);
        if (m) yearCols.push({ col: c, year: Number(m[1]) });
      }
      const monthlyCol = yearCols.length ? yearCols[yearCols.length - 1].col + 1 : 26;
      for (let r = 13; r <= 20; r++) {
        const name = text(dash.getCell(r, 21).value);
        if (!name || key(name) === "total") continue;
        saveLoan(db, {
          name,
          principalCents: cents(num(dash.getCell(r, 22).value) ?? 0),
          monthlyCents: cents(num(dash.getCell(r, monthlyCol).value) ?? 0),
          paidOff: false,
          mortgage: /habita|casa/.test(key(name)),
          sort: r,
          amortizations: yearCols.map(({ col, year }) => ({
            year,
            amountCents: cents(num(dash.getCell(r, col).value) ?? 0),
          })),
        });
        report.loans++;
      }
      tiePlanLines(db);
    } else report.warnings.push("Sheet 'Main Dashboard' not found: salary and plan not imported.");
  });

  return report;
}
