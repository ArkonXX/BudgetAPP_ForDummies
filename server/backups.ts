// Copies of the database kept on the server: one a day, and one just before
// anything that replaces the data (Excel import, wipe, restore), so a mistake
// can always be undone from Settings.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "./db.ts";
import type { BackupFile, BackupReason } from "../shared/types.ts";

const REASONS: BackupReason[] = ["daily", "before-import", "before-wipe", "before-restore"];
const NAME = /^budget-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(daily|before-import|before-wipe|before-restore)\.db$/;
// How many copies of each kind are kept; older ones are deleted.
const KEEP = { daily: 30, other: 20 };

export class BackupError extends Error {}

export const isBackupName = (name: string) => NAME.test(name);

/** Writes a consistent copy of the open database to a file. */
export function snapshotTo(db: DB, file: string): void {
  rmSync(file, { force: true });
  db.prepare("VACUUM INTO ?").run(file);
}

// Tables restored from a copy; sessions stay, so restoring doesn't log you out.
function dataTables(db: DB, schema = "main"): string[] {
  return (
    db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .filter((n) => n !== "sessions");
}

/**
 * Replaces all data with the data in a database file (a copy made by the app).
 * The copy is first brought up to date with the current tables, so a copy
 * made by an older version of the app can be restored too.
 */
export function restoreFrom(db: DB, file: string): void {
  if (!readFileSync(file).subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "binary")))
    throw new BackupError("not_a_backup");
  const work = join(tmpdir(), `budget-restore-${process.pid}-${Date.now()}.db`);
  copyFileSync(file, work);
  try {
    const check = new DatabaseSync(work);
    const tables = dataTables(check);
    check.close();
    if (!tables.includes("transactions") || !tables.includes("categories")) throw new BackupError("not_a_backup");
    openDb(work).close();

    db.exec(`ATTACH DATABASE '${work.replace(/'/g, "''")}' AS restore_src`);
    try {
      const cols = (schema: string, table: string) =>
        (db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
      const source = new Set(dataTables(db, "restore_src"));
      db.exec("PRAGMA foreign_keys = OFF");
      try {
        db.exec("BEGIN");
        try {
          for (const table of dataTables(db)) {
            db.exec(`DELETE FROM main."${table}"`);
            if (!source.has(table)) continue;
            const from = new Set(cols("restore_src", table));
            const shared = cols("main", table).filter((c) => from.has(c)).map((c) => `"${c}"`).join(", ");
            if (shared) db.exec(`INSERT INTO main."${table}" (${shared}) SELECT ${shared} FROM restore_src."${table}"`);
          }
          db.exec("COMMIT");
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      } finally {
        db.exec("PRAGMA foreign_keys = ON");
      }
    } finally {
      db.exec("DETACH DATABASE restore_src");
    }
  } finally {
    rmSync(work, { force: true });
    rmSync(`${work}-wal`, { force: true });
    rmSync(`${work}-shm`, { force: true });
  }
}

export function createBackups(db: DB, dir: string) {
  mkdirSync(dir, { recursive: true });

  function list(): BackupFile[] {
    return readdirSync(dir)
      .map((name) => {
        const m = NAME.exec(name);
        if (!m) return null;
        return {
          name,
          createdAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}`,
          reason: m[5] as BackupReason,
          sizeBytes: statSync(join(dir, name)).size,
        };
      })
      .filter((b): b is BackupFile => b !== null)
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  function prune() {
    const all = list();
    const old = [
      ...all.filter((b) => b.reason === "daily").slice(KEEP.daily),
      ...all.filter((b) => b.reason !== "daily").slice(KEEP.other),
    ];
    for (const b of old) rmSync(join(dir, b.name), { force: true });
  }

  /** Makes a copy now and returns it. `now` is local time. */
  function create(reason: BackupReason, now = new Date()): BackupFile {
    if (!REASONS.includes(reason)) throw new BackupError("invalid reason");
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
    const name = `budget-${stamp}-${reason}.db`;
    snapshotTo(db, join(dir, name));
    prune();
    return list().find((b) => b.name === name)!;
  }

  /** The day's copy, unless one was already made today. */
  function daily(now = new Date()): BackupFile | null {
    const p = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    if (list().some((b) => b.reason === "daily" && b.createdAt.startsWith(today))) return null;
    return create("daily", now);
  }

  function path(name: string): string {
    if (!isBackupName(name) || !list().some((b) => b.name === name)) throw new BackupError("not_found");
    return join(dir, name);
  }

  /** Restores a kept copy, after keeping a copy of what is there now. */
  function restore(name: string): void {
    const file = path(name);
    create("before-restore");
    restoreFrom(db, file);
  }

  /** Restores an uploaded file, after keeping a copy of what is there now. */
  function restoreUpload(data: Buffer): void {
    const file = join(tmpdir(), `budget-upload-${process.pid}-${Date.now()}.db`);
    writeFileSync(file, data);
    try {
      // Checked before the copy of the current data is made, so a wrong file changes nothing.
      if (!data.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "binary"))) throw new BackupError("not_a_backup");
      create("before-restore");
      restoreFrom(db, file);
    } finally {
      rmSync(file, { force: true });
    }
  }

  return { dir, list, create, daily, path, restore, restoreUpload };
}

export type Backups = ReturnType<typeof createBackups>;
