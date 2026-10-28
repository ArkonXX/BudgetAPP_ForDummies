// Shapes exchanged between the server and the web app. Money is always in
// integer cents to avoid floating point drift.

export type Kind = "expense" | "income";

// How an expense category is shown on the Budget and Year plan: loan payments,
// fixed monthly bills, or day-to-day spending.
export type ExpenseGroup = "credit" | "fixed" | "variable";

export interface Category {
  id: number;
  kind: Kind;
  name: string;
  plannedCents: number;
  sort: number;
  archived: boolean;
  group: ExpenseGroup; // expenses only
  // Day-to-day expenses only: the account their money goes to on payday, to
  // be spent from there. Other expenses get theirs from their Plan line.
  accountId: number | null;
}

export interface Transaction {
  id: number;
  kind: Kind;
  date: string;
  amountCents: number;
  description: string;
  categoryId: number | null;
  // false = an expense still to pay. It stays out of the totals and carries
  // over month after month until it is paid; its date is when it was due.
  paid: boolean;
  accountId: number;
  // Set when the expense is one installment of a purchase paid in parts.
  installment: { planId: number; seq: number; count: number } | null;
}

export interface Account {
  id: number;
  name: string;
  openingCents: number;
  isDefault: boolean; // new entries and imported ones go here unless another is picked
  sort: number;
  archived: boolean;
  balanceCents: number; // opening + income - expenses +/- transfers - savings deposits + withdrawals +/- personal loans linked to it +/- adjustments
}

/** What closing a month does with its leftover or shortfall. */
export type CloseAction = "carry" | "pot" | "none";

export interface AccountAdjustment {
  id: number;
  accountId: number;
  date: string;
  amountCents: number; // added to the app's balance so it matches the bank
}

export interface MonthClose {
  month: string;
  closedAt: string;
  balanceCents: number; // the month's balance when it was closed
  action: CloseAction;
  potId: number | null;
  potCents: number; // put in the pot (leftover) or taken out of it (shortfall)
  carryCents: number; // passed on to the next month's balance
  adjustments: AccountAdjustment[];
}

export interface Transfer {
  id: number;
  date: string;
  amountCents: number;
  fromAccountId: number;
  toAccountId: number;
  note: string;
  budgetMonth: string | null; // set when confirmed from the monthly suggestion: the month it pays for
}

// What one account needs from the salary account to pay its debits in a budget month.
export interface TransferNeed {
  accountId: number;
  neededCents: number;
  balanceCents: number; // the account's balance today
  parts: { name: string; cents: number; kind: PlanSection | "loan" | "unpaid" | "category" }[]; // plan items on the account, day-to-day categories spent from it, and unpaid installments due
  transfer: Transfer | null; // the month's transfer, once confirmed
}

// The suggested transfers on payday from the account the salary comes into.
export interface TransferPlan {
  month: string;
  payday: string; // the day the budget month starts (salary of the month before)
  salaryAccountId: number;
  needs: TransferNeed[];
}

// A purchase paid in installments (e.g. Klarna "pay in 3"). Each installment
// is an expense of its own, left unpaid until it is paid.
export interface InstallmentPlan {
  id: number;
  name: string;
  totalCents: number;
  count: number;
  everyDays: number | null; // null = same day every month
  categoryId: number | null;
  installments: Transaction[];
  paidCents: number;
  remainingCents: number;
  nextDue: string | null; // date of the next unpaid installment
}

export interface SavingsPot {
  id: number;
  name: string;
  goalCents: number;
  balanceCents: number;
  sort: number;
}

export interface SavingsMovement {
  id: number;
  potId: number;
  date: string;
  amountCents: number; // positive = deposit, negative = withdrawal
  place: string;
  note: string;
  opening: boolean; // starting balance carried over, not counted as a deposit
  accountId: number | null; // account the money left (deposit) or went back to (withdrawal)
}

export type PlanSection = "fixed" | "subscription" | "investment" | "donation" | "annual";

export interface PlanItem {
  id: number;
  section: PlanSection;
  name: string;
  amountCents: number;
  month: number | null; // only for "annual": the month (1-12) it is paid
  sort: number;
  // Subscriptions only: debited on this day of each month (clamped to the
  // month's last day) and then added as a paid expense automatically.
  debitDay: number | null;
  categoryId: number | null; // null = the "Subscrições" category
  accountId: number | null; // the account it is paid from; null = the default account
}

// A subscription debit still to come in a budget month.
export interface UpcomingDebit {
  itemId: number;
  name: string;
  date: string;
  amountCents: number;
  categoryId: number | null;
  accountId: number; // the subscription's account, or the default one
}

// Money that moved because of a personal loan, shown with the entries.
export interface LoanMove {
  key: string;
  date: string;
  person: string;
  repay: boolean; // a repayment rather than the loan itself
  amountCents: number; // positive = money in, negative = money out
  accountId: number | null; // null = no account was chosen
  note: string;
}

export interface Loan {
  id: number;
  name: string;
  principalCents: number;
  monthlyCents: number;
  paidOff: boolean; // paid-off loans no longer count in the monthly commitments
  mortgage: boolean; // the house loan: left out of Baby Step 2, it is Baby Step 6
  sort: number;
  accountId: number | null; // the account the monthly payment leaves from; null = the default account
  amortizations: { year: number; amountCents: number }[];
}

// Money lent to or borrowed from a person, outside the bank loans above.
export type PersonalLoanDirection = "lent" | "borrowed";

export interface PersonalLoanPayment {
  id: number;
  loanId: number;
  date: string;
  amountCents: number;
  note: string;
  batch: string | null; // set when one repayment to a person was split across several loans
  accountId: number | null; // the account the money came into or left; null = not tracked
}

export interface PersonalLoan {
  id: number;
  person: string;
  direction: PersonalLoanDirection; // lent = they owe me, borrowed = I owe them
  date: string;
  amountCents: number;
  dueDate: string | null;
  note: string;
  accountId: number | null; // the account the money came into or left; null = not tracked
  payments: PersonalLoanPayment[];
  paidCents: number;
  outstandingCents: number;
}

// Baby Steps are worked out from the app's data, never ticked by hand.
export type BabyStepStatus = "done" | "pending" | "na"; // na = does not apply

export interface BabyStep {
  step: number;
  status: BabyStepStatus;
  // How far along the step is: money in cents, or a count of loans.
  progress: { current: number; target: number; unit: "cents" | "count" } | null;
}

export interface BabyStepSettings {
  emergencyPotId: number | null; // null = the pot whose name contains "emerg"
  starterFundCents: number; // step 1 target
  emergencyMonths: number; // step 3: months of average expenses
  investPercent: number; // step 4: share of net salary
  educationPotId: number | null; // step 5; null = does not apply
}

export interface Settings {
  salaryCents: number;
  /** "lastBusinessDay": the budget month starts on payday, the month's last working day. */
  monthStartMode: "lastBusinessDay" | "fixedDay";
  monthStartDay: number; // used when monthStartMode is "fixedDay"
  plannedSavingsCents: number;
  salaryAccountId: number | null; // the account the salary comes into; null = worked out from the entries
}

export interface SummaryLine {
  categoryId: number | null;
  name: string;
  group: ExpenseGroup;
  // Expenses only: the accounts the money leaves from, from the month's
  // entries and debits, or the Plan lines tied to the category.
  accountIds: number[];
  plannedCents: number;
  actualCents: number;
  // Expenses only: still to pay by the end of the month (carried over and
  // installments) plus subscription debits still to come.
  toPayCents: number;
}

export interface MonthSummary {
  month: string;
  from: string;
  to: string;
  expenses: SummaryLine[];
  income: SummaryLine[];
  savingsCents: number; // deposited into savings pots during the month
  plannedSavingsCents: number;
  totalExpenseCents: number;
  totalIncomeCents: number;
  plannedExpenseCents: number;
  plannedIncomeCents: number;
  balanceCents: number; // income - expenses - savings - repaid to people
  savingsTotalCents: number; // current total across all pots
  pending: (Transaction & { dueMonth: string })[]; // unpaid expenses due by the end of the month, incl. carried over
  pendingCents: number;
  upcoming: UpcomingDebit[]; // subscription debits later this month, not added yet
  upcomingCents: number;
  // Paid back to people I borrowed from during the month. Money borrowed counts
  // nowhere; it only counts in the month it is paid back.
  repaid: { person: string; cents: number }[];
  repaidCents: number;
  carriedInCents: number; // leftover (or shortfall) passed on by closing the month before; in balanceCents
  close: MonthClose | null; // set once the month is closed
  canClose: boolean; // a past month not closed yet
  canReopen: boolean; // closed, and the month after is not
  previousOpen: string | null; // on the current month: the month before, when it has entries and is not closed
}

// The planning grid on the Budget screen, like the spreadsheet's planning
// sheet: one column per budget month, one row per category.
export interface PlanCell {
  plannedCents: number;
  actualCents: number;
  toPayCents: number; // unpaid or still to be debited in that month
  custom: boolean; // planned amount set for this month only
}

export interface PlanRow {
  key: string;
  kind: "income" | "expense" | "savings" | "repaid";
  categoryId: number | null;
  name: string; // repaid: the person
  group: ExpenseGroup; // expense rows
  cells: PlanCell[];
}

export interface PlanMonth {
  month: string;
  status: "past" | "current" | "future";
  incomeCents: number; // what the month has to spend
  endCents: number; // what is left at the end of the month; negative means short
}

export interface PlanGrid {
  months: PlanMonth[];
  rows: PlanRow[];
}

export interface BalanceRow {
  month: string;
  incomeCents: number;
  expenseCents: number;
  savingsCents: number;
  balanceCents: number;
  byCategory: Record<number, number>;
}

export interface BalanceReport {
  months: BalanceRow[];
  categories: { id: number; name: string }[];
  yearlyAverages: { year: number; byCategory: Record<number, number> }[];
}

// Suggestions shown on the overview. The web app turns each one into a
// sentence; `amountCents` is what happened, `compareCents` what it is
// measured against (the plan or the usual spending).
export type TipType =
  | "overBudget"
  | "unplanned"
  | "aboveUsual"
  | "belowUsual"
  | "savingsBehind"
  | "annualNext";

export interface Tip {
  type: TipType;
  level: "bad" | "warn" | "info" | "good";
  name: string; // category or plan item name, "" when not about one
  amountCents: number;
  compareCents: number;
}

export interface Overview {
  summary: MonthSummary;
  days: number; // length of the budget month
  elapsedDays: number; // 0 for a future month, `days` for a past one
  // Running total of expenses at the end of each day of the month so far.
  cumulativeCents: number[];
  // The same for the whole previous budget month.
  previousCumulativeCents: number[];
  // Expected expenses by month end: spent so far plus what is usually spent
  // in the rest of the month. Null when the month is not in progress.
  projectedExpenseCents: number | null;
  history: { month: string; incomeCents: number; expenseCents: number; savingsCents: number }[];
  pots: SavingsPot[];
  tips: Tip[];
  debts: Debts;
}

// What is still owed today, for the overview: personal loans by person and
// purchases in installments.
export interface Debts {
  people: { person: string; netCents: number }[]; // positive = owed to me, negative = I owe
  owedToMeCents: number;
  iOweCents: number;
  installmentsLeftCents: number;
}

// A line read from a bank statement file, shown for review before it is saved.
export interface StatementRow {
  date: string;
  description: string;
  amountCents: number; // negative = money out of the account
  // Starts unticked: pending/declined (Revolut), another currency, or a Revolut
  // vault/savings line rather than the current account.
  skip: "notCompleted" | "currency" | "otherProduct" | null;
  duplicate: boolean; // the account already has a move that day for this amount
  closed: boolean; // dated in a closed month, so it can't be added
  categoryId: number | null; // the one last used for the same description
  loanPerson: string | null; // a person from Loans whose name is in the description
}

export interface StatementPreview {
  format: "revolut" | "bank";
  rows: StatementRow[];
}
