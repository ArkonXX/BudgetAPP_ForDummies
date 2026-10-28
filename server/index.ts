import { resolve } from "node:path";
import { openDb } from "./db.ts";
import { createApp } from "./app.ts";

const password = process.env.APP_PASSWORD;
if (!password || password.length < 8) {
  console.error("Set APP_PASSWORD (at least 8 characters) before starting the server.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "0.0.0.0";
const db = openDb(process.env.DB_PATH ?? "data/budget.db");

const app = createApp(db, {
  password,
  secureCookie: process.env.COOKIE_SECURE === "1",
  staticDir: resolve(import.meta.dirname, "../dist"),
});

app.listen(port, host, () => {
  console.log(`My Budget is running on http://${host}:${port}`);
});
