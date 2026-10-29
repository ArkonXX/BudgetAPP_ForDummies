import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { createBackups } from "./backups.ts";
import * as store from "./store.ts";

const count = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n;
const addExpense = (db: ReturnType<typeof openDb>, cents: number) =>
  db.prepare("INSERT INTO transactions (kind, date, amount_cents, description) VALUES ('expense', '2026-10-01', ?, 'x')").run(cents);

test("one daily copy a day, the oldest are deleted", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-bk-"));
  try {
    const db = openDb(":memory:");
    const b = createBackups(db, dir);
    assert.ok(b.daily(new Date(2026, 9, 1, 3)));
    assert.equal(b.daily(new Date(2026, 9, 1, 22)), null);
    for (let d = 2; d <= 35; d++) b.daily(new Date(2026, 9, d, 3));
    const daily = b.list().filter((x) => x.reason === "daily");
    assert.equal(daily.length, 30);
    assert.equal(daily[0].createdAt, "2026-11-04T03:00:00");
    // Copies made before an import aren't counted with the daily ones.
    b.create("before-import");
    assert.equal(b.list().length, 31);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore brings back the data and keeps a copy of what was there", () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-bk-"));
  try {
    const db = openDb(":memory:");
    const b = createBackups(db, dir);
    addExpense(db, 100);
    const copy = b.create("daily");
    addExpense(db, 200);
    addExpense(db, 300);
    assert.equal(count(db), 3);

    b.restore(copy.name);
    assert.equal(count(db), 1);
    assert.ok(store.listAccounts(db).some((a) => a.isDefault));
    // What was there before the restore is kept, so the restore can be undone.
    const before = b.list().find((x) => x.reason === "before-restore")!;
    b.restoreUpload(readFileSync(b.path(before.name)));
    assert.equal(count(db), 3);

    const junk = join(dir, "junk.db");
    writeFileSync(junk, "not a database");
    assert.throws(() => b.restoreUpload(readFileSync(junk)), /not_a_backup/);
    assert.equal(count(db), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wipe and Excel import keep a copy first; copies can be listed and restored over the API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "budget-bk-"));
  const db = openDb(":memory:");
  const backups = createBackups(db, dir);
  const server = createApp(db, { password: "correct-horse", secureCookie: false, backups }).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try {
    const headers = { "Content-Type": "application/json", "X-Budget-App": "1" };
    const login = await fetch(`${base}/login`, { method: "POST", headers, body: JSON.stringify({ password: "correct-horse" }) });
    const authed = { ...headers, Cookie: login.headers.get("set-cookie")!.split(";")[0] };
    addExpense(db, 500);

    const wipe = await fetch(`${base}/wipe`, { method: "POST", headers: authed, body: JSON.stringify({ password: "correct-horse" }) });
    assert.equal(wipe.status, 200);
    assert.equal(count(db), 0);

    const list = (await (await fetch(`${base}/backups`, { headers: authed })).json()) as { backups: { name: string; reason: string }[] };
    assert.equal(list.backups.length, 1);
    assert.equal(list.backups[0].reason, "before-wipe");

    const file = await fetch(`${base}/backups/${list.backups[0].name}`, { headers: authed });
    assert.equal(file.status, 200);
    assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 15).toString(), "SQLite format 3");
    assert.equal((await fetch(`${base}/backups/..%2Fbudget.db`, { headers: authed })).status, 404);

    const restore = await fetch(`${base}/backups/${list.backups[0].name}/restore`, { method: "POST", headers: authed });
    assert.equal(restore.status, 200);
    assert.equal(count(db), 1);
    // Still logged in after a restore.
    assert.equal((await fetch(`${base}/backups`, { headers: authed })).status, 200);

    await fetch(`${base}/import`, { method: "POST", headers: { ...authed, "Content-Type": "application/octet-stream" }, body: "not a workbook" });
    assert.ok(backups.list().some((x) => x.reason === "before-import"));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
