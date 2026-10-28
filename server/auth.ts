import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { DB } from "./db.ts";

const COOKIE = "budget_session";
const SESSION_DAYS = 30;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest();

export function passwordMatches(given: string, expected: string): boolean {
  return timingSafeEqual(sha256(given), sha256(expected));
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export function createAuth(db: DB, opts: { password: string; secureCookie: boolean }) {
  const failures = new Map<string, { count: number; until: number }>();

  const cookie = (value: string, maxAgeSec: number) =>
    [
      `${COOKIE}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAgeSec}`,
      opts.secureCookie ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; ");

  function isLoggedIn(req: Request): boolean {
    const token = readCookie(req, COOKIE);
    if (!token) return false;
    const row = db
      .prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
      .get(sha256(token).toString("hex")) as { expires_at: number } | undefined;
    return !!row && row.expires_at > Date.now();
  }

  function login(req: Request, res: Response) {
    const ip = req.ip ?? "unknown";
    const f = failures.get(ip);
    if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
      res.status(429).json({ error: "too_many_attempts" });
      return;
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!passwordMatches(password, opts.password)) {
      const count = f && f.until > Date.now() ? f.count + 1 : 1;
      failures.set(ip, { count, until: Date.now() + LOCKOUT_MS });
      res.status(401).json({ error: "wrong_password" });
      return;
    }
    failures.delete(ip);
    const token = randomBytes(32).toString("base64url");
    const expires = Date.now() + SESSION_DAYS * 86400_000;
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());
    db.prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)").run(
      sha256(token).toString("hex"),
      expires,
    );
    res.setHeader("Set-Cookie", cookie(token, SESSION_DAYS * 86400));
    res.json({ ok: true });
  }

  function logout(req: Request, res: Response) {
    const token = readCookie(req, COOKIE);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token).toString("hex"));
    res.setHeader("Set-Cookie", cookie("", 0));
    res.json({ ok: true });
  }

  /** Requires a session, and for writes a custom header that other sites cannot send (CSRF). */
  function requireAuth(req: Request, res: Response, next: NextFunction) {
    if (!isLoggedIn(req)) {
      res.status(401).json({ error: "not_logged_in" });
      return;
    }
    if (req.method !== "GET" && req.get("X-Budget-App") !== "1") {
      res.status(403).json({ error: "missing_header" });
      return;
    }
    next();
  }

  return { isLoggedIn, login, logout, requireAuth };
}
