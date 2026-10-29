// Reads a statement exported from a bank app (Revolut CSV, Montepio CSV or
// Excel, or any similar file) for one account. Nothing is saved here: the
// preview goes back to the web app, where every line is reviewed, and only
// the lines confirmed there are saved by commitStatement.

import ExcelJS from "exceljs";
import type { DB } from "./db.ts";
import { tx } from "./db.ts";
import { categoryHints, isClosedDate, payPerson, saveMovement, savePersonalLoan, saveTransaction, saveTransfer } from "./store.ts";
import { descriptionKey } from "../shared/describe.ts";
import type { StatementPreview, StatementRow } from "../shared/types.ts";

export class StatementError extends Error {}

/** Lowercase, no accents, dots or currency marks: "Data Mov." -> "data mov". */
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\((eur|€)\)|€|\./g, "")
    .replace(/\s+/g, " ")
    .trim();

// Column names seen in bank exports, in order of preference.
const COLUMNS = {
  date: [
    "completed date", "data de conclusao", "started date", "data de inicio", "data mov", "data movimento",
    "data do movimento", "data lancamento", "data operacao", "data", "date", "booking date", "transaction date",
  ],
  // Revolut leaves the completed date empty on pending lines.
  startDate: ["started date", "data de inicio"],
  description: ["description", "descricao", "descritivo", "descricao do movimento", "movimento", "detalhes", "details"],
  amount: ["amount", "montante", "valor", "importancia", "montante eur", "valor eur"],
  debit: ["debito", "debitos", "debit", "saida", "saidas"],
  credit: ["credito", "creditos", "credit", "entrada", "entradas"],
  fee: ["fee", "comissao", "taxa"],
  state: ["state", "estado"],
  currency: ["currency", "moeda"],
  // Revolut puts the current account, savings vaults and flexible accounts in one file.
  product: ["product", "produto"],
};
type Column = keyof typeof COLUMNS;

function findColumns(header: string[]): Partial<Record<Column, number>> {
  const names = header.map(norm);
  const found: Partial<Record<Column, number>> = {};
  for (const col of Object.keys(COLUMNS) as Column[]) {
    for (const alias of COLUMNS[col]) {
      const i = names.indexOf(alias);
      if (i >= 0) {
        found[col] = i;
        break;
      }
    }
  }
  return found;
}

/** "2026-10-03 14:02:11", "03-10-2026", "03/10/26" -> "2026-10-03"; null otherwise. */
export function parseDate(s: string): string | null {
  s = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/.exec(s);
    if (!m) return null;
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += 2000;
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** "-1.234,56 €", "1,234.56", "12.5", "(3,00)" -> signed cents; null when not a number. */
export function parseAmount(input: string): number | null {
  let s = input.replace(/[€\s ]|EUR/gi, "");
  if (!s) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) [s, sign] = [s.slice(1, -1), -1];
  if (s.endsWith("-")) [s, sign] = [s.slice(0, -1), -sign];
  if (s.startsWith("-")) [s, sign] = [s.slice(1), -sign];
  else if (s.startsWith("+")) s = s.slice(1);
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) s = comma > dot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  // A lone comma is the decimal mark ("12,50"), unless it groups thousands ("1,234").
  else if (comma >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  // Same for a lone dot used for thousands, as in "1.234".
  else if (dot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(s) && s.split(".").length > 2) s = s.replace(/\./g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return sign * Math.round(Number(s) * 100);
}

function decode(data: Buffer): string {
  // Portuguese banks often export in Windows-1252, not UTF-8.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    text = new TextDecoder("windows-1252").decode(data);
  }
  return text.replace(/^﻿/, "");
}

/** Splits CSV text into rows, with quoted fields and the separator the file uses. */
export function parseCsv(text: string): string[][] {
  const firstLines = text.split(/\r?\n/).slice(0, 30).join("\n");
  const sep = [";", "\t", ","]
    .map((c) => ({ c, n: firstLines.split(c).length }))
    .sort((a, b) => b.n - a.n)[0].c;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Undoes UTF-8 text that was read as Latin-1 somewhere along the way ("FarmÃ¡cia"). */
export function fixMojibake(s: string): string {
  if (!/[ÃÂ][\u0080-\u00bf]/.test(s)) return s;
  const fixed = Buffer.from(s, "latin1").toString("utf8");
  return fixed.includes("\ufffd") ? s : fixed;
}

async function readXlsx(data: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow((r) => {
    const cells: string[] = [];
    r.eachCell({ includeEmpty: true }, (cell, col) => {
      let v = cell.value as unknown;
      if (v && typeof v === "object" && "result" in v) v = (v as { result: unknown }).result;
      if (v && typeof v === "object" && "richText" in v)
        v = (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("");
      cells[col - 1] = v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? "" : String(v);
    });
    rows.push(Array.from(cells, (c) => c ?? ""));
  });
  return rows;
}

/**
 * Works out the columns of a file without column names from the lines that
 * start with a date: the description is the column with text, the amount the
 * first column with numbers (a later one is the running balance).
 */
function guessColumns(rows: string[][]): Partial<Record<Column, number>> {
  const lines = rows.filter((r) => parseDate(r[0] ?? "")).slice(0, 50);
  if (lines.length === 0) return {};
  const width = Math.max(...lines.map((r) => r.length));
  const share = (col: number, test: (v: string) => boolean) =>
    lines.filter((r) => test((r[col] ?? "").trim())).length / lines.length;
  const cols: Partial<Record<Column, number>> = { date: 0 };
  for (let c = 1; c < width; c++) {
    if (share(c, (v) => parseDate(v) != null) > 0.8) continue; // value date
    if (cols.amount === undefined && share(c, (v) => parseAmount(v) != null) > 0.8) cols.amount = c;
    else if (cols.description === undefined && cols.amount === undefined && share(c, (v) => v !== "" && parseAmount(v) == null) > 0.5)
      cols.description = c;
  }
  return cols;
}

type Line = Omit<StatementRow, "duplicate" | "closed" | "categoryId" | "loanPerson">;

/** Reads the file into dated, signed lines (negative = money out of the account). */
export async function readStatement(data: Buffer): Promise<{ format: StatementPreview["format"]; lines: Line[] }> {
  let rows: string[][];
  if (data.subarray(0, 2).toString("latin1") === "PK") rows = await readXlsx(data);
  else if (data.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) throw new StatementError("xls_not_supported");
  else rows = parseCsv(decode(data));

  // Banks put a few lines (account, period) above the column names.
  let headerAt = -1;
  let cols: Partial<Record<Column, number>> = {};
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const c = findColumns(rows[i]);
    if (c.date !== undefined && (c.amount !== undefined || c.debit !== undefined || c.credit !== undefined)) {
      headerAt = i;
      cols = c;
      break;
    }
  }
  if (headerAt < 0) {
    // Montepio's Net24 export (.xls that is really tab-separated text) has no
    // column names: Data mov., Data valor, Descrição, Montante, Saldo.
    cols = guessColumns(rows);
    if (cols.date === undefined || cols.amount === undefined) throw new StatementError("unrecognized_statement");
  }
  const cell = (r: string[], c: Column) => (cols[c] === undefined ? "" : (r[cols[c]!] ?? "").trim());
  const format = cols.product !== undefined ? "revolut" : "bank";
  const isCurrent = (r: string[]) => ["current", "atual", "corrente", "conta corrente"].includes(norm(cell(r, "product")));
  // Lines of vaults and savings start unticked, unless the file has no current-account lines at all.
  const hasCurrent = cols.product !== undefined && rows.slice(headerAt + 1).some(isCurrent);

  const lines: Line[] = [];
  for (const r of rows.slice(headerAt + 1)) {
    const date = parseDate(cell(r, "date")) ?? parseDate(cell(r, "startDate"));
    if (!date) continue; // totals, balances and other footer lines
    let amount: number | null;
    if (cols.amount !== undefined) amount = parseAmount(cell(r, "amount"));
    else {
      const debit = parseAmount(cell(r, "debit")) ?? 0;
      const credit = parseAmount(cell(r, "credit")) ?? 0;
      amount = Math.abs(credit) - Math.abs(debit);
    }
    if (amount == null) continue;
    amount -= Math.abs(parseAmount(cell(r, "fee")) ?? 0);
    if (amount === 0) continue;
    const state = norm(cell(r, "state"));
    const currency = cell(r, "currency").toUpperCase();
    const skip =
      state && !["completed", "concluida", "concluido", "concluidas"].includes(state)
        ? "notCompleted"
        : currency && currency !== "EUR"
          ? "currency"
          : hasCurrent && !isCurrent(r)
            ? "otherProduct"
            : null;
    lines.push({ date, description: fixMojibake(cell(r, "description")).replace(/\s+/g, " ").slice(0, 200), amountCents: amount, skip });
  }
  if (lines.length === 0) throw new StatementError("no_lines");
  return { format, lines };
}

/**
 * How the account's balance already moved on each day by each amount, from entries,
 * transfers, savings and personal loans (a repayment split across loans is one move).
 */
// An expense the app added on a subscription's or loan's debit day.
const AUTOMATIC = `(EXISTS (SELECT 1 FROM plan_charges c WHERE c.transaction_id = t.id)
  OR EXISTS (SELECT 1 FROM loan_charges c WHERE c.transaction_id = t.id))`;
// How far from its debit day the bank can date a direct debit.
const DEBIT_DAYS = 5;

/** Subscription and loan debits the app added to the account, which the bank may date a few days off. */
function automaticDebits(db: DB, accountId: number): { date: string; cents: number; used: boolean }[] {
  return (
    db
      .prepare(
        `SELECT date, -amount_cents AS cents FROM transactions t
          WHERE kind = 'expense' AND COALESCE(account_id, (SELECT id FROM accounts WHERE is_default = 1)) = ? AND ${AUTOMATIC}`,
      )
      .all(accountId) as { date: string; cents: number }[]
  ).map((r) => ({ ...r, used: false }));
}

const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400_000;

function existingMoves(db: DB, accountId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT date, CASE kind WHEN 'expense' THEN -amount_cents ELSE amount_cents END AS cents FROM transactions t
        WHERE COALESCE(account_id, (SELECT id FROM accounts WHERE is_default = 1)) = ?1 AND NOT ${AUTOMATIC}
      UNION ALL SELECT date, -amount_cents FROM transfers WHERE from_account_id = ?1
      UNION ALL SELECT date, amount_cents FROM transfers WHERE to_account_id = ?1
      UNION ALL SELECT date, -amount_cents FROM savings_movements WHERE account_id = ?1 AND opening = 0
      UNION ALL SELECT date, CASE direction WHEN 'borrowed' THEN amount_cents ELSE -amount_cents END
        FROM personal_loans WHERE account_id = ?1
      UNION ALL SELECT MIN(p.date), SUM(CASE l.direction WHEN 'lent' THEN p.amount_cents ELSE -p.amount_cents END)
        FROM personal_loan_payments p JOIN personal_loans l ON l.id = p.loan_id WHERE p.account_id = ?1
        GROUP BY COALESCE(p.batch, p.id)`,
    )
    .all(accountId) as { date: string; cents: number }[];
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.date}|${r.cents}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** "MB WAY  Inês" -> "mb way ines", so names match however the bank writes them. */
const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** People from Loans whose whole name appears in a description, longest names first. */
function personFinder(db: DB): (description: string) => string | null {
  const people = (db.prepare("SELECT person FROM personal_loans ORDER BY date DESC, id DESC").all() as { person: string }[])
    .map((r) => ({ name: r.person.trim(), key: plain(r.person) }))
    .filter((p, i, all) => p.key.length >= 3 && all.findIndex((q) => q.key === p.key) === i)
    .sort((a, b) => b.key.length - a.key.length);
  return (description) => {
    const text = ` ${plain(description)} `;
    return people.find((p) => text.includes(` ${p.key} `))?.name ?? null;
  };
}

export async function previewStatement(db: DB, accountId: number, data: Buffer): Promise<StatementPreview> {
  const { format, lines } = await readStatement(data);
  const moves = existingMoves(db, accountId);
  const debits = automaticDebits(db, accountId);
  // A line is an automatic debit if one is on the same day, or else within a few days.
  const debitFor = (l: Line, exact: boolean) =>
    debits
      .filter((d) => !d.used && d.cents === l.amountCents && (exact ? d.date === l.date : daysApart(d.date, l.date) <= DEBIT_DAYS))
      .sort((a, b) => daysApart(a.date, l.date) - daysApart(b.date, l.date))[0];
  const guesses = new Map(categoryHints(db).map((h) => [`${h.kind}|${descriptionKey(h.description)}`, h.categoryId]));
  const findPerson = personFinder(db);
  // A line counts as already in the app when the account has a move on the same
  // day for the same amount; each move matches one line only.
  const known = lines.map((l) => {
    const key = `${l.date}|${l.amountCents}`;
    const left = moves.get(key) ?? 0;
    if (left > 0) {
      moves.set(key, left - 1);
      return true;
    }
    const d = debitFor(l, true);
    if (d) d.used = true;
    return d != null;
  });
  lines.forEach((l, i) => {
    if (known[i]) return;
    const d = debitFor(l, false);
    if (d) d.used = known[i] = true;
  });
  const rows = lines.map((l, i): StatementRow => {
    const kind = l.amountCents < 0 ? "expense" : "income";
    return {
      ...l,
      duplicate: known[i],
      closed: isClosedDate(db, l.date),
      categoryId: guesses.get(`${kind}|${descriptionKey(l.description)}`) ?? null,
      loanPerson: findPerson(l.description),
    };
  });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { format, rows };
}

export interface ConfirmedLine {
  date: string;
  description: string;
  amountCents: number; // signed, as in the preview
  categoryId: number | null;
  transferAccountId: number | null; // set when the line is money moved to/from another of my accounts
  potId: number | null; // set when the line is money put in or taken out of a savings pot
  // Set when the line is a personal loan: money lent or borrowed (new), or paid back (repay).
  loan?: { person: string; repay: boolean } | null;
}

export function commitStatement(db: DB, accountId: number, lines: ConfirmedLine[]) {
  let transactions = 0;
  let transfers = 0;
  let savings = 0;
  let loans = 0;
  tx(db, () => {
    for (const l of lines) {
      const cents = Math.abs(l.amountCents);
      const incoming = l.amountCents > 0;
      if (l.loan) {
        if (l.loan.repay) {
          // Money in pays back what I lent; money out pays back what I borrowed.
          const paid = payPerson(db, {
            person: l.loan.person,
            direction: incoming ? "lent" : "borrowed",
            date: l.date,
            amountCents: cents,
            note: l.description,
            accountId,
          });
          if (!paid) throw new StatementError("more_than_owed");
        } else {
          savePersonalLoan(db, {
            person: l.loan.person,
            direction: incoming ? "borrowed" : "lent",
            date: l.date,
            amountCents: cents,
            dueDate: null,
            note: l.description,
            accountId,
          });
        }
        loans++;
      } else if (l.potId != null) {
        // Money leaving the account is a deposit into the pot.
        saveMovement(db, { potId: l.potId, date: l.date, amountCents: -l.amountCents, place: "", note: l.description, opening: false, accountId });
        savings++;
      } else if (l.transferAccountId != null) {
        const out = l.amountCents < 0;
        saveTransfer(db, {
          date: l.date,
          amountCents: cents,
          fromAccountId: out ? accountId : l.transferAccountId,
          toAccountId: out ? l.transferAccountId : accountId,
          note: l.description,
        });
        transfers++;
      } else {
        saveTransaction(db, {
          kind: l.amountCents < 0 ? "expense" : "income",
          date: l.date,
          amountCents: cents,
          description: l.description,
          categoryId: l.categoryId,
          paid: true,
          accountId,
        });
        transactions++;
      }
    }
  });
  return { transactions, transfers, savings, loans };
}
