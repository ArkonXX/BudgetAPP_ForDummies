import { dirname, resolve } from "node:path";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";
import { createBackups } from "./backups.ts";

const password = process.env.APP_PASSWORD;
if (!password || password.length < 8) {
  console.error("Set APP_PASSWORD (at least 8 characters) before starting the server.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const dbPath = process.env.DB_PATH ?? "data/budget.db";
const db = openDb(dbPath);

// A copy of the database each day, kept next to it unless BACKUP_DIR points elsewhere
// (e.g. another disk or a NAS folder, so a failed disk doesn't take the copies with it).
const backups = createBackups(db, process.env.BACKUP_DIR ?? resolve(dirname(dbPath), "backups"));
const dailyBackup = () => {
  try {
    const made = backups.daily();
    if (made) console.log(`Backup saved: ${made.name}`);
  } catch (err) {
    console.error("Backup failed:", err);
  }
};
dailyBackup();
setInterval(dailyBackup, 60 * 60 * 1000).unref();

const app = createApp(db, {
  password,
  secureCookie: process.env.COOKIE_SECURE === "1",
  staticDir: resolve(import.meta.dirname, "../dist"),
  backups,
});

app.listen(port, host, () => {
  console.log(`My Budget is running on http://${host}:${port}`);
});
