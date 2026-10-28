// Usage: npm run import -- path/to/My_Budget.xlsx
// Replaces everything in the database with the workbook's contents.
import { readFileSync } from "node:fs";
import { openDb } from "./db.ts";
import { importWorkbook } from "./import-excel.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run import -- <file.xlsx>");
  process.exit(1);
}
const db = openDb(process.env.DB_PATH ?? "data/budget.db");
const report = await importWorkbook(db, readFileSync(file));
console.log(JSON.stringify(report, null, 2));
