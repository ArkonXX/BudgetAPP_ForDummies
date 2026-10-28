import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, setMonthClosedHandler, setUnauthorizedHandler } from "./api";
import { useI18n, type Key } from "./i18n";
import { Icon, type IconName } from "./icons";
import { monthOf, monthStartOf, todayISO } from "../shared/period";
import type { Account, Category, Settings } from "../shared/types";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Transactions from "./pages/Transactions";
import Budget from "./pages/Budget";
import YearPlan from "./pages/YearPlan";
import Savings from "./pages/Savings";
import Balance from "./pages/Balance";
import Loans from "./pages/Loans";
import Accounts from "./pages/Accounts";
import BankImport from "./pages/BankImport";
import Plan from "./pages/Plan";
import SettingsPage from "./pages/Settings";

interface AppState {
  settings: Settings;
  categories: Category[];
  accounts: Account[];
  month: string;
  setMonth: (m: string) => void;
  refresh: () => Promise<void>;
  logout: () => void;
}

const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside App");
  return ctx;
}

const NAV: { to: string; label: Key; icon: IconName; main: boolean }[] = [
  { to: "/", label: "navDashboard", icon: "home", main: true },
  { to: "/entries", label: "navTransactions", icon: "list", main: true },
  { to: "/budget", label: "navBudget", icon: "pie", main: true },
  { to: "/year", label: "navYearPlan", icon: "grid", main: false },
  { to: "/savings", label: "navSavings", icon: "target", main: true },
  { to: "/accounts", label: "navAccounts", icon: "card", main: false },
  { to: "/balance", label: "navBalance", icon: "bars", main: false },
  { to: "/loans", label: "navLoans", icon: "swap", main: false },
  { to: "/plan", label: "navPlan", icon: "calendar", main: false },
  { to: "/settings", label: "navSettings", icon: "gear", main: false },
];

export default function App() {
  const { t } = useI18n();
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [month, setMonth] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const inMore = NAV.some((n) => !n.main && pathname.startsWith(n.to));

  useEffect(() => {
    setUnauthorizedHandler(() => setLoggedIn(false));
    api
      .get<{ loggedIn: boolean }>("/me")
      .then((r) => setLoggedIn(r.loggedIn))
      .catch(() => setLoggedIn(false));
  }, []);

  useEffect(() => setMonthClosedHandler(() => alert(t("monthClosedError"))), [t]);

  const refresh = useCallback(async () => {
    const [s, c, a] = await Promise.all([
      api.get<Settings>("/settings"),
      api.get<Category[]>("/categories"),
      api.get<Account[]>("/accounts"),
    ]);
    setSettings(s);
    setCategories(c);
    setAccounts(a);
    setMonth((m) => m ?? monthOf(todayISO(), monthStartOf(s)));
  }, []);

  useEffect(() => {
    if (loggedIn) refresh().catch(() => {});
  }, [loggedIn, refresh]);

  const logout = () => {
    api.post("/logout", {}).finally(() => {
      setLoggedIn(false);
      setSettings(null);
    });
  };

  if (loggedIn === null) return null;
  if (!loggedIn) return <Login onLogin={() => setLoggedIn(true)} />;
  if (!settings || !month) return <p className="muted center">{t("loading")}</p>;

  return (
    <AppContext.Provider value={{ settings, categories, accounts, month, setMonth, refresh, logout }}>
      <div className="layout">
        <nav className="sidebar" aria-label="main">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">€</span>
            {t("appName")}
          </div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === "/"} className="nav-link">
              <Icon name={n.icon} />
              {t(n.label)}
            </NavLink>
          ))}
        </nav>
        {/* The year plan is a wide grid: let it use the whole screen. */}
        <main className={`content${pathname === "/year" ? " wide" : ""}`}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/entries" element={<Transactions />} />
            <Route path="/budget" element={<Budget />} />
            <Route path="/year" element={<YearPlan />} />
            <Route path="/savings" element={<Savings />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/accounts/import" element={<BankImport />} />
            <Route path="/balance" element={<Balance />} />
            <Route path="/loans" element={<Loans />} />
            <Route path="/plan" element={<Plan />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
        <nav className="tabbar" aria-label="main">
          {NAV.filter((n) => n.main).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              className="tab"
              aria-label={t(n.label)}
              onClick={() => setMoreOpen(false)}
            >
              <Icon name={n.icon} />
              <span className="tab-label">{t(n.label)}</span>
            </NavLink>
          ))}
          <button
            className={`tab ${moreOpen ? "open" : ""} ${inMore ? "in-more" : ""}`}
            aria-label={t("navMore")}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
          >
            <Icon name="more" />
          </button>
          {moreOpen && (
            <div className="more-menu">
              {NAV.filter((n) => !n.main).map((n) => (
                <NavLink key={n.to} to={n.to} className="nav-link" onClick={() => setMoreOpen(false)}>
                  <Icon name={n.icon} />
                  {t(n.label)}
                </NavLink>
              ))}
            </div>
          )}
        </nav>
      </div>
    </AppContext.Provider>
  );
}
