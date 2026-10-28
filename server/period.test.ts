import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths, lastBusinessDay, monthOf, periodRange, portugueseHolidays } from "../shared/period.ts";

test("budget month starting on the 25th", () => {
  assert.deepEqual(periodRange("2026-02", 25), { from: "2026-01-25", to: "2026-02-25" });
  assert.deepEqual(periodRange("2026-01", 25), { from: "2025-12-25", to: "2026-01-25" });
  assert.equal(monthOf("2026-01-30", 25), "2026-02");
  assert.equal(monthOf("2026-02-27", 25), "2026-03");
  assert.equal(monthOf("2026-02-10", 25), "2026-02");
  assert.equal(monthOf("2025-12-31", 25), "2026-01");
});

test("calendar months when the start day is 1", () => {
  assert.deepEqual(periodRange("2026-12", 1), { from: "2026-12-01", to: "2027-01-01" });
  assert.equal(monthOf("2026-12-31", 1), "2026-12");
});

test("addMonths crosses years", () => {
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2025-12", 1), "2026-01");
});

test("last working day skips weekends and Portuguese holidays", () => {
  // The salary dates from the workbook.
  assert.equal(lastBusinessDay(2025, 11), "2025-11-28"); // 30th is a Sunday
  assert.equal(lastBusinessDay(2025, 12), "2025-12-31");
  assert.equal(lastBusinessDay(2026, 1), "2026-01-30"); // 31st is a Saturday
  assert.equal(lastBusinessDay(2026, 2), "2026-02-27"); // 28th is a Saturday
  // Good Friday on 30 March 2018, with the 31st a Saturday.
  assert.equal(lastBusinessDay(2018, 3), "2018-03-29");
  assert.ok(portugueseHolidays(2026).has("2026-04-03")); // Sexta-feira Santa
  assert.ok(portugueseHolidays(2026).has("2026-06-04")); // Corpo de Deus
});

test("budget month starting on payday", () => {
  assert.deepEqual(periodRange("2026-02", "lastBusinessDay"), { from: "2026-01-30", to: "2026-02-27" });
  assert.deepEqual(periodRange("2026-01", "lastBusinessDay"), { from: "2025-12-31", to: "2026-01-30" });
  assert.equal(monthOf("2026-01-30", "lastBusinessDay"), "2026-02");
  assert.equal(monthOf("2026-01-29", "lastBusinessDay"), "2026-01");
  assert.equal(monthOf("2026-02-27", "lastBusinessDay"), "2026-03");
  assert.equal(monthOf("2025-12-31", "lastBusinessDay"), "2026-01");
});
