import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { useI18n, type Key } from "../i18n";
import { dateLabel, decimal, decimalInput, money, parseDecimal } from "../format";
import { Loading, Modal, Money, MoneyField, Section, useLoad } from "../components";
import { todayISO } from "../../shared/period";
import type { Investment, InvestmentKind, InvestmentTrade, Portfolio, TradeSide } from "../../shared/types";

const KINDS: { kind: InvestmentKind; label: Key }[] = [
  { kind: "stock", label: "invKindStock" },
  { kind: "etf", label: "invKindEtf" },
  { kind: "fund", label: "invKindFund" },
  { kind: "crypto", label: "invKindCrypto" },
  { kind: "other", label: "invKindOther" },
];

/** "+12,3 %" of the cost; nothing when nothing was paid. */
function Growth({ gain, cost }: { gain: number; cost: number }) {
  const { lang } = useI18n();
  if (cost <= 0) return null;
  const pct = (gain / cost) * 100;
  return (
    <span className={`num small ${pct < 0 ? "neg" : pct > 0 ? "pos" : ""}`}>
      {pct > 0 ? "+" : ""}
      {decimal(pct, lang, 1)} %
    </span>
  );
}

function DecimalField({
  label,
  value,
  onChange,
  suffix,
  autoFocus,
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
  suffix?: string;
  autoFocus?: boolean;
}) {
  const { lang } = useI18n();
  const [text, setText] = useState(decimalInput(value, lang));
  return (
    <label className="field">
      <span>{label}</span>
      <div className="money-input">
        <input
          inputMode="decimal"
          autoFocus={autoFocus}
          value={text}
          placeholder="0"
          onChange={(e) => {
            setText(e.target.value);
            onChange(parseDecimal(e.target.value));
          }}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
    </label>
  );
}

function InvestmentForm({ initial, onClose, onSaved }: { initial?: Investment; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [ticker, setTicker] = useState(initial?.ticker ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<InvestmentKind>(initial?.kind ?? "etf");
  const [quote, setQuote] = useState<number | null>(initial?.quote ?? null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await api.post("/investments", { id: initial?.id, ticker, name, kind, quote, quoteDate: todayISO() });
    onSaved();
    onClose();
  };
  const remove = async () => {
    if (!initial || !confirm(t("invDeleteConfirm"))) return;
    await api.del(`/investments/${initial.id}`);
    onSaved();
    onClose();
  };
  return (
    <Modal title={initial ? initial.ticker : t("invNew")} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>{t("invTicker")}</span>
          <input required maxLength={20} autoCapitalize="characters" value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="VWCE" />
        </label>
        <label className="field">
          <span>{t("name")}</span>
          <input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("invKind")}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as InvestmentKind)}>
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {t(k.label)}
              </option>
            ))}
          </select>
        </label>
        <DecimalField label={t("invQuote")} value={quote} onChange={setQuote} suffix="€" />
        <p className="muted small">{t("invQuoteHelp")}</p>
        <div className="form-actions">
          {initial && (
            <button type="button" className="btn danger" onClick={remove}>
              {t("delete")}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn primary">{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

function TradeForm({
  investment,
  initial,
  side: startSide,
  onClose,
  onSaved,
}: {
  investment: Investment;
  initial?: InvestmentTrade;
  side: TradeSide;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useI18n();
  const [side, setSide] = useState<TradeSide>(initial?.side ?? startSide);
  const [date, setDate] = useState(initial?.date ?? todayISO());
  const [quantity, setQuantity] = useState<number | null>(initial?.quantity ?? null);
  const [total, setTotal] = useState<number | null>(initial?.totalCents ?? null);
  const [note, setNote] = useState(initial?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const unit = quantity && total != null ? total / 100 / quantity : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (quantity == null) return setError(t("invInvalidQuantity"));
    if (total == null || total < 0) return setError(t("invalidAmount"));
    try {
      await api.post("/investments/trades", { id: initial?.id, investmentId: investment.id, date, side, quantity, totalCents: total, note });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "sell_more_than_held" ? t("invSellTooMuch") : t("error"));
    }
  };
  const remove = async () => {
    if (!initial || !confirm(t("confirmDelete"))) return;
    try {
      await api.del(`/investments/trades/${initial.id}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.code === "sell_more_than_held" ? t("invDeleteBuyUsed") : t("error"));
    }
  };

  return (
    <Modal title={`${side === "buy" ? t("invBuy") : t("invSell")} · ${investment.ticker}`} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="segmented">
          <button type="button" className={side === "buy" ? "active" : ""} onClick={() => setSide("buy")}>
            {t("invBuy")}
          </button>
          <button type="button" className={side === "sell" ? "active" : ""} onClick={() => setSide("sell")}>
            {t("invSell")}
          </button>
        </div>
        <DecimalField label={t("invQuantity")} value={quantity} onChange={setQuantity} autoFocus={!initial} />
        <MoneyField label={side === "buy" ? t("invTotalPaid") : t("invTotalReceived")} cents={total} onChange={setTotal} />
        <p className="muted small">
          {t("invFeesIncluded")}
          {unit != null && ` · ${t("invUnitPrice")}: ${decimal(unit, lang, 4)} €`}
        </p>
        <label className="field">
          <span>{t("date")}</span>
          <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("note")}</span>
          <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          {initial && (
            <button type="button" className="btn danger" onClick={remove}>
              {t("delete")}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="btn primary">{t("save")}</button>
        </div>
      </form>
    </Modal>
  );
}

function InvestmentDetail({ investment: i, onClose, onChanged }: { investment: Investment; onClose: () => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const [trade, setTrade] = useState<{ side: TradeSide; initial?: InvestmentTrade } | null>(null);
  const [editing, setEditing] = useState(false);
  const [quote, setQuote] = useState<number | null>(i.quote);
  const [saved, setSaved] = useState(false);
  const saveQuote = async () => {
    if (quote == null) return;
    await api.post("/investments", { id: i.id, ticker: i.ticker, name: i.name, kind: i.kind, quote, quoteDate: todayISO() });
    setSaved(true);
    onChanged();
  };

  return (
    <>
    <Modal title={i.name ? `${i.ticker} · ${i.name}` : i.ticker} onClose={onClose}>
      <dl className="inv-facts">
        <dt>{t("invQuantity")}</dt>
        <dd className="num">{decimal(i.quantity, lang)}</dd>
        <dt>{t("invAverageCost")}</dt>
        <dd className="num">{i.averageCost == null ? "—" : `${decimal(i.averageCost, lang, 4)} €`}</dd>
        <dt>{t("invCost")}</dt>
        <dd className="num">{money(i.costCents, lang)}</dd>
        <dt>{t("invValue")}</dt>
        <dd className="num">{money(i.valueCents, lang)}</dd>
        <dt>{t("invGain")}</dt>
        <dd>
          <Money cents={i.gainCents} signed /> <Growth gain={i.gainCents} cost={i.costCents} />
        </dd>
        {i.realizedCents !== 0 && (
          <>
            <dt>{t("invRealized")}</dt>
            <dd>
              <Money cents={i.realizedCents} signed />
            </dd>
          </>
        )}
      </dl>

      <div className="inv-quote">
        <DecimalField label={t("invQuote")} value={quote} onChange={(q) => (setQuote(q), setSaved(false))} suffix="€" />
        <button className="btn small-btn" disabled={quote == null || quote === i.quote} onClick={saveQuote}>
          {t("save")}
        </button>
      </div>
      <p className="muted small">
        {saved ? t("saved_") : i.quoteDate ? t("invQuoteOn", { date: dateLabel(i.quoteDate, lang) }) : t("invNoQuote")}
      </p>

      <div className="form-actions">
        <button className="btn" onClick={() => setEditing(true)}>
          {t("edit")}
        </button>
        <span className="spacer" />
        <button className="btn" disabled={i.quantity <= 0} onClick={() => setTrade({ side: "sell" })}>
          {t("invSell")}
        </button>
        <button className="btn primary" onClick={() => setTrade({ side: "buy" })}>
          {t("invBuy")}
        </button>
      </div>

      <h3 className="backup-kept">{t("invTrades")}</h3>
      {i.trades.length === 0 ? (
        <p className="muted small">{t("invNoTrades")}</p>
      ) : (
        <ul className="list">
          {i.trades.map((x) => (
            <li key={x.id}>
              <button className="list-row" onClick={() => setTrade({ side: x.side, initial: x })}>
                <div className="list-main">
                  <strong>
                    {x.side === "buy" ? t("invBought") : t("invSoldTrade")} · {decimal(x.quantity, lang)}
                  </strong>
                  <span className="muted small">
                    {dateLabel(x.date, lang)} · {decimal(x.totalCents / 100 / x.quantity, lang, 4)} €
                    {x.note ? ` · ${x.note}` : ""}
                  </span>
                </div>
                <Money cents={x.side === "buy" ? -x.totalCents : x.totalCents} signed />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
    {/* Opened next to the detail, not inside it, so they show on top of it. */}
    {trade && <TradeForm investment={i} side={trade.side} initial={trade.initial} onClose={() => setTrade(null)} onSaved={onChanged} />}
    {editing && <InvestmentForm initial={i} onClose={() => setEditing(false)} onSaved={onChanged} />}
    </>
  );
}

export default function Investments() {
  const { t, lang } = useI18n();
  const { data, error, reload } = useLoad(() => api.get<Portfolio>("/investments"), []);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  if (!data) return <Loading error={error} />;
  const held = data.investments.filter((i) => i.quantity > 0 || i.trades.length === 0);
  const sold = data.investments.filter((i) => i.quantity <= 0 && i.trades.length > 0);
  const open = data.investments.find((i) => i.id === openId);
  const share = (i: Investment) => (data.valueCents > 0 ? (i.valueCents / data.valueCents) * 100 : 0);

  const row = (i: Investment) => (
    <li key={i.id}>
      <button className="list-row" onClick={() => setOpenId(i.id)}>
        <div className="list-main">
          <strong>
            {i.ticker}
            {i.name && <span className="muted"> · {i.name}</span>}
          </strong>
          <span className="muted small">
            {i.quantity > 0
              ? `${decimal(i.quantity, lang)} × ${i.quote == null ? "—" : `${decimal(i.quote, lang, 4)} €`} · ${decimal(share(i), lang, 1)} %`
              : i.trades.length === 0
                ? t("invNoTrades")
                : `${t("invRealized")}: ${money(i.realizedCents, lang)}`}
          </span>
        </div>
        <div className="inv-amounts">
          <strong className="num">{money(i.valueCents, lang)}</strong>
          {i.quantity > 0 && (
            <span>
              <Money cents={i.gainCents} signed /> <Growth gain={i.gainCents} cost={i.costCents} />
            </span>
          )}
        </div>
      </button>
    </li>
  );

  return (
    <div className="page">
      <header className="page-head">
        <h1>{t("navInvestments")}</h1>
        <button className="btn" onClick={() => setAdding(true)}>
          + {t("invNew")}
        </button>
      </header>

      <div className="card hero">
        <span className="muted">{t("invPortfolioValue")}</span>
        <div className="hero-value">{money(data.valueCents, lang)}</div>
        <span className="small">
          <span className="muted">{t("invGain")}: </span>
          <Money cents={data.gainCents} signed /> <Growth gain={data.gainCents} cost={data.costCents} />
          <span className="muted"> · {t("invCost")}: {money(data.costCents, lang)}</span>
          {data.realizedCents !== 0 && (
            <>
              <span className="muted"> · {t("invRealized")}: </span>
              <Money cents={data.realizedCents} signed />
            </>
          )}
        </span>
      </div>

      {data.investments.length === 0 ? (
        <p className="muted center">{t("invEmpty")}</p>
      ) : (
        <>
          <ul className="list card">{held.map(row)}</ul>
          {sold.length > 0 && (
            <Section title={t("invSold")}>
              <ul className="list">{sold.map(row)}</ul>
            </Section>
          )}
        </>
      )}
      <p className="muted small">{t("invNotInBudget")}</p>

      {adding && (
        <InvestmentForm
          onClose={() => setAdding(false)}
          onSaved={reload}
        />
      )}
      {open && <InvestmentDetail key={open.id} investment={open} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}
