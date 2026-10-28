// Dave Ramsey's Baby Steps, worked out from the app's data:
//   1. starter emergency fund: the emergency pot reaches the starter target
//   2. debt free: every loan except the house is paid off, and no money owed to people
//   3. full emergency fund: the emergency pot covers N months of average expenses
//   4. invest: the plan's monthly investments reach a share of the net salary
//   5. college fund: the chosen education pot reaches its goal (no pot = does not apply)
//   6. house paid off: every mortgage is paid off (no mortgage = does not apply)
//   7. build wealth and give: steps 1 to 6 are all done or do not apply
import type { DB } from "./db.ts";
import {
  getBabyStepSettings,
  getSettings,
  listLoans,
  listPersonalLoans,
  listPlanItems,
  listPots,
} from "./store.ts";
import { todayISO } from "../shared/period.ts";
import type { BabyStep, SavingsPot } from "../shared/types.ts";

const key = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The pot used as emergency fund: the one chosen in settings, else the one named "Emergências". */
export function emergencyPot(pots: SavingsPot[], chosenId: number | null): SavingsPot | undefined {
  if (chosenId != null) return pots.find((p) => p.id === chosenId);
  return pots.find((p) => key(p.name).includes("emerg"));
}

/** Average expenses per calendar month over the last 12 full months that have any expense. */
export function averageMonthlyExpenses(db: DB, today = todayISO()): number {
  const [y, m] = today.split("-").map(Number);
  const to = `${y}-${String(m).padStart(2, "0")}-01`;
  const from = `${y - 1}-${String(m).padStart(2, "0")}-01`;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(DISTINCT substr(date, 1, 7)) AS months
       FROM transactions WHERE kind = 'expense' AND paid = 1 AND date >= ? AND date < ?`,
    )
    .get(from, to) as { total: number; months: number };
  return row.months ? Math.round(Number(row.total) / Number(row.months)) : 0;
}

const reached = (current: number, target: number) => target > 0 && current >= target;

export function computeBabySteps(db: DB, today = todayISO()): BabyStep[] {
  const cfg = getBabyStepSettings(db);
  const pots = listPots(db);
  const loans = listLoans(db);
  const emergency = emergencyPot(pots, cfg.emergencyPotId)?.balanceCents ?? 0;

  const step1 = { current: emergency, target: cfg.starterFundCents, unit: "cents" as const };

  const debts = loans.filter((l) => !l.mortgage);
  const owed = listPersonalLoans(db).filter((p) => p.direction === "borrowed" && p.outstandingCents > 0);
  const step2 = {
    current: debts.filter((l) => l.paidOff).length,
    target: debts.length + owed.length,
    unit: "count" as const,
  };

  const step3 = {
    current: emergency,
    target: Math.round(averageMonthlyExpenses(db, today) * cfg.emergencyMonths),
    unit: "cents" as const,
  };

  const invested = listPlanItems(db)
    .filter((i) => i.section === "investment")
    .reduce((a, i) => a + i.amountCents, 0);
  const step4 = {
    current: invested,
    target: Math.round((getSettings(db).salaryCents * cfg.investPercent) / 100),
    unit: "cents" as const,
  };

  const education = cfg.educationPotId == null ? undefined : pots.find((p) => p.id === cfg.educationPotId);
  const mortgages = loans.filter((l) => l.mortgage);

  const steps: BabyStep[] = [
    { step: 1, status: reached(step1.current, step1.target) ? "done" : "pending", progress: step1 },
    { step: 2, status: step2.current === step2.target ? "done" : "pending", progress: step2.target ? step2 : null },
    { step: 3, status: reached(step3.current, step3.target) ? "done" : "pending", progress: step3 },
    { step: 4, status: reached(step4.current, step4.target) ? "done" : "pending", progress: step4 },
    education
      ? {
          step: 5,
          status: reached(education.balanceCents, education.goalCents) ? "done" : "pending",
          progress: { current: education.balanceCents, target: education.goalCents, unit: "cents" },
        }
      : { step: 5, status: "na", progress: null },
    mortgages.length
      ? {
          step: 6,
          status: mortgages.every((l) => l.paidOff) ? "done" : "pending",
          progress: { current: mortgages.filter((l) => l.paidOff).length, target: mortgages.length, unit: "count" },
        }
      : { step: 6, status: "na", progress: null },
  ];
  steps.push({ step: 7, status: steps.every((s) => s.status !== "pending") ? "done" : "pending", progress: null });
  return steps;
}
