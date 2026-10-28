import type { Lang } from "./i18n";

const locale = (lang: Lang) => (lang === "pt" ? "pt-PT" : "en-GB");

export function money(cents: number, lang: Lang): string {
  return new Intl.NumberFormat(locale(lang), { style: "currency", currency: "EUR" }).format(
    cents / 100,
  );
}

/** "2026-02" -> "Fevereiro 2026" / "February 2026". */
export function monthLabel(month: string, lang: Lang, short = false): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, 1));
  if (short) {
    // pt-PT renders {month: "short", year} as "05/2026", so build "mai 2026" by hand.
    const name = new Intl.DateTimeFormat(locale(lang), { month: "short", timeZone: "UTC" })
      .format(date)
      .replace(".", "");
    return `${name.charAt(0).toUpperCase() + name.slice(1)} ${y}`;
  }
  const s = new Intl.DateTimeFormat(locale(lang), { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function monthName(month1: number, lang: Lang): string {
  const s = new Intl.DateTimeFormat(locale(lang), { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, month1 - 1, 1)),
  );
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function dateLabel(date: string, lang: Lang): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(lang), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Parses "12,50", "12.50" or "1.234,56" into cents. Returns null when invalid. */
export function parseMoney(input: string): number | null {
  let s = input.trim().replace(/[€\s]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else {
    s = s.replace(",", ".");
  }
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** Cents -> editable string, "12,50" style for Portuguese. */
export function moneyInput(cents: number, lang: Lang): string {
  const s = (cents / 100).toFixed(2);
  return lang === "pt" ? s.replace(".", ",") : s;
}
