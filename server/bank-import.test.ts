import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.ts";
import { commitStatement, fixMojibake, parseAmount, parseDate, previewStatement } from "./bank-import.ts";
import { ensureCategory, ensurePot, listAccounts, listPersonalLoans, listPots, saveAccount, savePersonalLoan, saveTransaction, saveTransfer } from "./store.ts";

const REVOLUT = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-10-01 12:03:11,2026-10-02 09:00:00,Continente,-23.45,0.00,EUR,COMPLETED,976.55
TOPUP,Current,2026-10-03 08:00:00,2026-10-03 08:00:01,Top-up by *1234,200.00,0.00,EUR,COMPLETED,1176.55
EXCHANGE,Current,2026-10-04 10:00:00,2026-10-04 10:00:00,Exchanged to USD,-50.00,0.50,EUR,COMPLETED,1126.05
CARD_PAYMENT,Current,2026-10-05 19:00:00,,Uber,-8.10,0.00,EUR,PENDING,
Interest,Deposit,2026-10-06 02:10:12,2026-10-06 02:10:12,Net Interest Paid to 'Savings',0.02,0.00,EUR,COMPLETED,295.05
`;

// Montepio-style: Windows-1252, ";" separators, a few lines before the columns, debit/credit columns.
const MONTEPIO = Buffer.from(
  `Conta;123456789\nPeríodo;01-10-2026 a 31-10-2026\n\nData Mov.;Data Valor;Descrição;Débito;Crédito;Saldo\n` +
    `01-10-2026;01-10-2026;COMPRA PINGO DOCE;12,30;;1.000,00\n` +
    `03-10-2026;03-10-2026;TRF REVOLUT;200,00;;800,00\n` +
    `05-10-2026;05-10-2026;VENCIMENTO;;1.850,75;2.650,75\n` +
    `;;Saldo final;;;2.650,75\n`,
  "latin1",
);

test("amounts and dates in the shapes banks use", () => {
  assert.equal(parseAmount("-1.234,56 €"), -123456);
  assert.equal(parseAmount("1,234.56"), 123456);
  assert.equal(parseAmount("12,5"), 1250);
  assert.equal(parseAmount("-23.45"), -2345);
  assert.equal(parseAmount("(3,00)"), -300);
  assert.equal(parseAmount("abc"), null);
  assert.equal(fixMojibake("FarmÃ¡cia"), "Farmácia");
  assert.equal(fixMojibake("Farmácia"), "Farmácia");
  assert.equal(parseDate("2026-10-02 09:00:00"), "2026-10-02");
  assert.equal(parseDate("03/10/2026"), "2026-10-03");
  assert.equal(parseDate("31-02-2026"), null);
});

test("Revolut CSV: fees subtracted, pending and vault lines flagged, duplicates and categories found", async () => {
  const db = openDb(":memory:");
  const acc = saveAccount(db, { name: "Revolut", openingCents: 0, isDefault: false, sort: 1, archived: false });
  const food = ensureCategory(db, "expense", "Supermercado");
  saveTransaction(db, { kind: "expense", date: "2026-09-10", amountCents: 1000, description: "Continente", categoryId: food, accountId: acc });
  saveTransaction(db, { kind: "income", date: "2026-10-03", amountCents: 20000, description: "", categoryId: null, accountId: acc });

  const p = await previewStatement(db, acc, Buffer.from(REVOLUT));
  assert.equal(p.format, "revolut");
  assert.deepEqual(
    p.rows.map((r) => [r.date, r.amountCents, r.skip, r.duplicate, r.categoryId]),
    [
      ["2026-10-02", -2345, null, false, food],
      ["2026-10-03", 20000, null, true, null],
      ["2026-10-04", -5050, null, false, null],
      ["2026-10-05", -810, "notCompleted", false, null],
      ["2026-10-06", 2, "otherProduct", false, null],
    ],
  );
});

test("Montepio-style CSV: header below account lines, debit/credit columns, Windows-1252", async () => {
  const db = openDb(":memory:");
  const montepio = saveAccount(db, { name: "Montepio", openingCents: 0, isDefault: false, sort: 1, archived: false });
  const revolut = saveAccount(db, { name: "Revolut", openingCents: 0, isDefault: false, sort: 2, archived: false });
  // The top-up was already saved as a transfer when the Revolut file was imported.
  saveTransfer(db, { date: "2026-10-03", amountCents: 20000, fromAccountId: montepio, toAccountId: revolut, note: "" });

  const p = await previewStatement(db, montepio, MONTEPIO);
  assert.equal(p.format, "bank");
  assert.deepEqual(
    p.rows.map((r) => [r.date, r.description, r.amountCents, r.duplicate]),
    [
      ["2026-10-01", "COMPRA PINGO DOCE", -1230, false],
      ["2026-10-03", "TRF REVOLUT", -20000, true],
      ["2026-10-05", "VENCIMENTO", 185075, false],
    ],
  );

  const r = commitStatement(db, montepio, [
    { date: "2026-10-01", description: "COMPRA PINGO DOCE", amountCents: -1230, categoryId: null, transferAccountId: null, potId: null },
    { date: "2026-10-05", description: "VENCIMENTO", amountCents: 185075, categoryId: null, transferAccountId: null, potId: null },
  ]);
  assert.deepEqual(r, { transactions: 2, transfers: 0, savings: 0, loans: 0 });
  // Importing the same file again finds everything already there.
  const again = await previewStatement(db, montepio, MONTEPIO);
  assert.ok(again.rows.every((x) => x.duplicate));
});

// Net24 "Movimentos de conta": an .xls that is really tab-separated text, blank lines instead of column names.
const NET24 = Buffer.from(
  "\t\t\t\t\n".repeat(9) +
    "2026-04-01\t2026-04-01\tCOMPRA   PADARIA CENTRAL\t-12,40\t987,60\n" +
    "2026-04-02\t2026-04-02\tTRANSF.P/D.P.  745-00.000000-0\t-500,00\t487,60\n" +
    "2026-04-04\t2026-04-02\tCOMPRA   LOJA ONLINE\t-25,90\t461,70\n" +
    "2026-04-30\t2026-04-30\tTR-IPS-EMPRESA EXEMPLO LDA\t1.500,00\t1.961,70\n",
  "latin1",
);

test("Montepio Net24 export without column names", async () => {
  const db = openDb(":memory:");
  const montepio = saveAccount(db, { name: "Montepio", openingCents: 0, isDefault: false, sort: 1, archived: false });
  const p = await previewStatement(db, montepio, NET24);
  assert.deepEqual(
    p.rows.map((r) => [r.date, r.description, r.amountCents]),
    [
      ["2026-04-01", "COMPRA PADARIA CENTRAL", -1240],
      ["2026-04-02", "TRANSF.P/D.P. 745-00.000000-0", -50000],
      ["2026-04-04", "COMPRA LOJA ONLINE", -2590],
      ["2026-04-30", "TR-IPS-EMPRESA EXEMPLO LDA", 150000],
    ],
  );

  // The term-deposit line goes into a savings pot, and then counts as already imported.
  const pot = ensurePot(db, "Depósito a prazo");
  assert.deepEqual(
    commitStatement(db, montepio, [
      { date: "2026-04-02", description: "TRANSF.P/D.P.", amountCents: -50000, categoryId: null, transferAccountId: null, potId: pot },
    ]),
    { transactions: 0, transfers: 0, savings: 1, loans: 0 },
  );
  assert.equal(listPots(db).find((x) => x.id === pot)!.balanceCents, 50000);
  const again = await previewStatement(db, montepio, NET24);
  assert.equal(again.rows[1].duplicate, true);
});

test("a confirmed transfer line moves money between the two accounts", async () => {
  const db = openDb(":memory:");
  const montepio = saveAccount(db, { name: "Montepio", openingCents: 0, isDefault: false, sort: 1, archived: false });
  const revolut = saveAccount(db, { name: "Revolut", openingCents: 0, isDefault: false, sort: 2, archived: false });
  commitStatement(db, revolut, [
    { date: "2026-10-03", description: "Top-up", amountCents: 20000, categoryId: null, transferAccountId: montepio, potId: null },
  ]);
  const p = await previewStatement(db, montepio, MONTEPIO);
  assert.equal(p.rows.find((x) => x.description === "TRF REVOLUT")!.duplicate, true);
});

test("personal loans: the person is suggested from the description, loans and repayments move the account", async () => {
  const db = openDb(":memory:");
  const montepio = saveAccount(db, { name: "Montepio", openingCents: 0, isDefault: false, sort: 1, archived: false });
  // Recorded by hand earlier, with no account.
  savePersonalLoan(db, { person: "Inês", direction: "borrowed", date: "2026-09-01", amountCents: 10000, dueDate: null, note: "" });
  savePersonalLoan(db, { person: "Rui", direction: "lent", date: "2026-09-01", amountCents: 5000, dueDate: null, note: "" });
  const file = Buffer.from(
    "Data;Descrição;Montante\n" +
      "02-10-2026;MB WAY DE INES;300,00\n" +
      "03-10-2026;TRF RUI SANTOS;20,00\n" +
      "04-10-2026;COMPRA RUINAS BAR;-5,00\n" +
      "05-10-2026;MB WAY P/ INÊS;-150,00\n",
    "latin1",
  );
  const p = await previewStatement(db, montepio, file);
  assert.deepEqual(p.rows.map((r) => r.loanPerson), ["Inês", "Rui", null, "Inês"]);

  const lines = p.rows.map((r) => ({ ...r, categoryId: null, transferAccountId: null, potId: null }));
  const r = commitStatement(db, montepio, [
    { ...lines[0], loan: { person: "Inês", repay: false } }, // she lent me 300 more
    { ...lines[1], loan: { person: "Rui", repay: true } }, // Rui paid back 20 of 50
    { ...lines[3], loan: { person: "Inês", repay: true } }, // I paid her back 150
  ]);
  assert.equal(r.loans, 3);
  const ines = listPersonalLoans(db).filter((l) => l.person === "Inês");
  assert.equal(ines.reduce((a, l) => a + l.outstandingCents, 0), 10000 + 30000 - 15000);
  assert.equal(listPersonalLoans(db).find((l) => l.person === "Rui")!.outstandingCents, 3000);
  // +300 borrowed, +20 repaid to me, -150 repaid by me.
  assert.equal(listAccounts(db).find((a) => a.id === montepio)!.balanceCents, 30000 + 2000 - 15000);
  const again = await previewStatement(db, montepio, file);
  assert.deepEqual(again.rows.map((x) => x.duplicate), [true, true, false, true]);

  // Paying back more than is owed is refused and nothing is saved.
  assert.throws(
    () => commitStatement(db, montepio, [{ ...lines[2], amountCents: -999999, loan: { person: "Inês", repay: true } }]),
    /more_than_owed/,
  );
  assert.equal(listPersonalLoans(db).length, 3);
});

test("files that aren't statements are refused", async () => {
  const db = openDb(":memory:");
  await assert.rejects(previewStatement(db, 1, Buffer.from("hello,world\n1,2\n")), /unrecognized_statement/);
});
