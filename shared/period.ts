// Budget months follow the salary cycle. Each budget month starts on the
// day the previous month's salary arrives, so a salary paid at the end of
// January funds February. The start is either:
//   "lastBusinessDay": the last working day of the month (no weekends or
//     Portuguese national holidays), e.g. February runs from Fri 2026-01-30
//     up to (not including) Fri 2026-02-27;
//   a day number: with 25, February runs from 2026-01-25 to 2026-02-25.
//     1 gives plain calendar months.

export type Month = string; // "YYYY-MM"
export type MonthStart = number | "lastBusinessDay";

/** Reads the month start out of the app settings. */
export function monthStartOf(s: { monthStartMode: "lastBusinessDay" | "fixedDay"; monthStartDay: number }): MonthStart {
  return s.monthStartMode === "fixedDay" ? s.monthStartDay : "lastBusinessDay";
}

const pad = (n: number) => String(n).padStart(2, "0");

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

function shift(year: number, month1: number, delta: number): [number, number] {
  const idx = year * 12 + (month1 - 1) + delta;
  return [Math.floor(idx / 12), (idx % 12) + 1];
}

export function parseMonth(m: Month): [number, number] {
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo || mo < 1 || mo > 12) throw new Error(`Invalid month: ${m}`);
  return [y, mo];
}

export function formatMonth(year: number, month1: number): Month {
  return `${year}-${pad(month1)}`;
}

export function addMonths(m: Month, delta: number): Month {
  const [y, mo] = parseMonth(m);
  return formatMonth(...shift(y, mo, delta));
}

/** Easter Sunday (Gregorian calendar), as [month1, day]. */
function easter(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month, ((h + l - 7 * m + 114) % 31) + 1];
}

function isoDate(year: number, month1: number, day: number): string {
  return `${year}-${pad(month1)}-${pad(day)}`;
}

const holidayCache = new Map<number, Set<string>>();

/** Portuguese national holidays (feriados nacionais obrigatórios) of a year. */
export function portugueseHolidays(year: number): Set<string> {
  let set = holidayCache.get(year);
  if (set) return set;
  const fixed: [number, number][] = [
    [1, 1], [4, 25], [5, 1], [6, 10], [8, 15], [10, 5], [11, 1], [12, 1], [12, 8], [12, 25],
  ];
  const [em, ed] = easter(year);
  const sunday = Date.UTC(year, em - 1, ed);
  const offset = (days: number) => new Date(sunday + days * 86400_000).toISOString().slice(0, 10);
  set = new Set([
    ...fixed.map(([m, d]) => isoDate(year, m, d)),
    offset(-2), // Sexta-feira Santa
    offset(0), // Páscoa
    offset(60), // Corpo de Deus
  ]);
  holidayCache.set(year, set);
  return set;
}

/** The last working day of a month: not a weekend and not a national holiday. */
export function lastBusinessDay(year: number, month1: number): string {
  const holidays = portugueseHolidays(year);
  for (let d = daysInMonth(year, month1); ; d--) {
    const weekday = new Date(Date.UTC(year, month1 - 1, d)).getUTCDay();
    const iso = isoDate(year, month1, d);
    if (weekday !== 0 && weekday !== 6 && !holidays.has(iso)) return iso;
  }
}

/** The date in a calendar month on which the next budget month starts. */
function boundary(year: number, month1: number, start: MonthStart): string {
  if (start === "lastBusinessDay") return lastBusinessDay(year, month1);
  return isoDate(year, month1, Math.min(start, daysInMonth(year, month1)));
}

const isCalendar = (start: MonthStart) => start !== "lastBusinessDay" && start <= 1;

/** Inclusive start and exclusive end dates ("YYYY-MM-DD") of a budget month. */
export function periodRange(m: Month, start: MonthStart): { from: string; to: string } {
  const [y, mo] = parseMonth(m);
  if (isCalendar(start)) {
    const [ny, nm] = shift(y, mo, 1);
    return { from: `${y}-${pad(mo)}-01`, to: `${ny}-${pad(nm)}-01` };
  }
  const [py, pm] = shift(y, mo, -1);
  return { from: boundary(py, pm, start), to: boundary(y, mo, start) };
}

/** The budget month a date ("YYYY-MM-DD") belongs to. */
export function monthOf(date: string, start: MonthStart): Month {
  const [y, mo] = date.split("-").map(Number);
  if (!isCalendar(start) && date >= boundary(y, mo, start)) {
    return formatMonth(...shift(y, mo, 1));
  }
  return formatMonth(y, mo);
}

/** Due date of installment `index` (0 = the first): every N days, or the same day each month. */
export function installmentDate(first: string, index: number, everyDays: number | null): string {
  const [y, m, d] = first.split("-").map(Number);
  if (everyDays != null) {
    const due = new Date(Date.UTC(y, m - 1, d + index * everyDays));
    return isoDate(due.getUTCFullYear(), due.getUTCMonth() + 1, due.getUTCDate());
  }
  // Same day each month, or the month's last day when it is shorter (31 Jan -> 28 Feb).
  const [year, month1] = shift(y, m, index);
  return isoDate(year, month1, Math.min(d, daysInMonth(year, month1)));
}

export function todayISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
