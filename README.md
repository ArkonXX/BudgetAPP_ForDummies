# My Budget / O Meu Orçamento

A personal budget web app based on the "My Budget" Excel workbook. It runs on a computer at home and is used from any browser on the local network (or over a private VPN such as Tailscale or NordVPN Meshnet). It works on phones (iOS and Android) and can be added to the home screen like an app. The interface is in Portuguese (Portugal) and English.

## What it does

| Screen | Excel sheet it replaces |
| --- | --- |
| Overview (Resumo) | Sumário: balance of the month, income, expenses, savings |
| Entries (Movimentos) | Despesas and Entradas |
| Budget (Orçamento) | Sumário: planned vs actual per category |
| Savings (Poupanças) | Poupanças / Poupancas: savings pots, deposits and withdrawals |
| Balance (Balanço) | Balanço and Estatísticas: month by month, per category, yearly averages |
| Plan (Planeamento) | Main Dashboard: salary, fixed costs, subscriptions, investments, donations, annual costs, loans, Baby Steps |
| Settings (Definições) | Language, budget month start day, categories, Excel import, backup |

### Budget month

Like the spreadsheet, a budget month follows the salary rather than the calendar. By default it starts on **payday, the last working day of the month** (weekends and Portuguese national holidays are skipped): the budget for February 2026 runs from Friday 30 January to Thursday 26 February, so the salary paid at the end of January counts for February and the budgets reset on the day it arrives. In Settings you can switch to a fixed day of the month instead (1 = calendar months).

## Running it at home

You need a computer that stays on (a PC, a Mac, a Raspberry Pi, a NAS with Docker…).

### With Docker (recommended)

```sh
cp .env.example .env        # then edit .env and choose a password
docker compose up -d --build
```

### Without Docker

Requires Node.js 22.13 or newer.

```sh
npm ci
npm run build
APP_PASSWORD='choose-a-password' npm start
```

Then open `http://<computer-ip>:8080` on your phone or computer. On iPhone use Safari → Share → *Add to Home Screen*; on Android use Chrome → ⋮ → *Add to Home screen*.

### Importing your Excel file

Go to **Settings → Import from Excel** and pick `My_Budget.xlsx`, or from the command line:

```sh
npm run import -- path/to/My_Budget.xlsx
```

Importing **replaces** all data in the app.

### Importing bank statements

Go to **Accounts → Import statement**, pick the account and the file exported from the bank:

- **Montepio**: Net24 → Movimentos de conta → export (`.xls`, which is really tab-separated text).
- **Revolut**: Statement → Excel/CSV (`.csv`).
- Other banks: most CSV or `.xlsx` exports with date, description and amount (or debit/credit) columns.

Nothing is saved straight away. Every line is listed for review: untick what you don't want and choose a category, a transfer to/from another account, or a savings pot. Lines whose date and amount match something already in the account start unticked, so importing the same file twice doesn't duplicate entries. The app never connects to the bank and doesn't store any bank login.

## Data and security

- All data lives in one SQLite file: `data/budget.db` (or the `./data` folder with Docker). Nothing is sent to the internet.
- **Settings → Backup** downloads a copy of the database. Copying `data/budget.db` works too.
- The app asks for the password set in `APP_PASSWORD`. Sessions last 30 days; after 5 wrong attempts sign-in is blocked for 15 minutes.
- Do not expose port 8080 to the internet. Use it on your home network or through a private VPN. If you put it behind HTTPS, set `COOKIE_SECURE=1`.

## Development

```sh
npm install
APP_PASSWORD=devpassword npm run dev   # API on :8080, web app on :5173
npm test                               # server tests
```

Stack: React + TypeScript (Vite) for the web app, Node.js + Express + SQLite (`node:sqlite`) for the server.

## Branches

`main` holds released versions and `devops` holds integrated work. Each change goes on its own branch and is merged into `devops` with a pull request; `devops` is merged into `main` with a pull request when it is ready to release.
