import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "./i18n";
import { money, monthLabel } from "./format";
import type { Overview } from "../shared/types";

/** A round axis maximum with 2-5 gridlines. */
export function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 10000, step: 5000 };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { top: Math.ceil(max / step) * step, step };
}

/** "1,5k €" style labels for chart axes. */
export function axisLabel(cents: number): string {
  const euros = cents / 100;
  if (euros === 0) return "0";
  return euros >= 1000 ? `${String(euros / 1000).replace(".", ",")}k €` : `${euros} €`;
}

type Series = "current" | "prev" | "plan";

/**
 * Running total of expenses this month against last month and the plan.
 * Drag or hover across it to read any day; tap a legend entry to hide a line.
 */
export default function SpendingChart({ data }: { data: Overview }) {
  const { t, lang } = useI18n();
  const { days, cumulativeCents: cur, previousCumulativeCents: prev } = data;
  const planned = data.summary.plannedExpenseCents;
  const last = cur.length;
  const [hidden, setHidden] = useState<Set<Series>>(new Set());
  const [active, setActive] = useState<number | null>(null); // 1-based day under the pointer
  const day = active ?? Math.max(last, 1);

  const has = { current: last > 0, prev: prev.length > 0, plan: planned > 0 };
  const shows = (s: Series) => has[s] && !hidden.has(s);
  const planAt = (d: number) => Math.round((planned * d) / days);

  const W = 340, H = 170, L = 40, R = 10, T = 10, B = 22;
  const { top, step } = niceScale(
    Math.max(
      shows("plan") ? planned : 0,
      shows("current") ? cur[last - 1] : 0,
      shows("prev") ? prev[Math.min(prev.length, days) - 1] : 0,
    ),
  );
  const x = (d: number) => L + ((d - 1) / Math.max(days - 1, 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const path = (arr: number[]) =>
    arr
      .slice(0, days)
      .map((v, i) => `${i ? "L" : "M"}${x(i + 1).toFixed(1)} ${y(v).toFixed(1)}`)
      .join(" ");
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const dayTicks = [1, 10, 20, days].filter((d, i, a) => d <= days && a.indexOf(d) === i && (d === days || days - d >= 4));
  const prevLabel = monthLabel(data.history[data.history.length - 2]?.month ?? data.summary.month, lang).split(" ")[0];

  const toggle = (s: Series) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(s)) next.add(s);
      return next;
    });

  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    const d = Math.round(((vx - L) / (W - L - R)) * (days - 1)) + 1;
    setActive(Math.min(days, Math.max(1, d)));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    setActive(Math.min(days, Math.max(1, day + delta)));
  };

  // Values shown in the readout for the selected day.
  const curVal = day <= last ? cur[day - 1] : null;
  const prevVal = day <= prev.length ? prev[day - 1] : null;
  const diff = curVal != null && prevVal != null ? curVal - prevVal : null;
  const points: { s: Series; v: number }[] = [];
  if (shows("plan")) points.push({ s: "plan", v: planAt(day) });
  if (shows("prev") && prevVal != null) points.push({ s: "prev", v: prevVal });
  if (shows("current") && curVal != null) points.push({ s: "current", v: curVal });

  const legend: { s: Series; label: string }[] = [
    { s: "current", label: t("thisMonth") },
    { s: "prev", label: prevLabel },
    { s: "plan", label: t("plannedLine", { amount: money(planned, lang) }) },
  ];

  return (
    <figure className="chart spend-chart">
      <div className="spend-readout" aria-live="polite">
        <span className="muted small">{t("dayN", { n: day })}</span>
        <div className="spend-values">
          {legend
            .filter((l) => shows(l.s))
            .map((l) => {
              const v = l.s === "current" ? curVal : l.s === "prev" ? prevVal : planAt(day);
              return (
                <div key={l.s} className={`spend-value ${l.s}`}>
                  <span className="muted small">
                    <i className={`swatch-line ${l.s}`} /> {l.s === "plan" ? t("planned") : l.label}
                  </span>
                  <span className="num">{v != null ? money(v, lang) : "–"}</span>
                </div>
              );
            })}
        </div>
        {diff != null && shows("current") && shows("prev") && diff !== 0 && (
          <span className={`small ${diff > 0 ? "neg" : "pos"}`}>
            {t(diff > 0 ? "moreThanMonth" : "lessThanMonth", { amount: money(Math.abs(diff), lang), month: prevLabel })}
          </span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart-svg interactive"
        role="img"
        aria-label={t("spendingOverMonth")}
        tabIndex={0}
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid-line" />
            <text x={L - 6} y={y(v) + 3} textAnchor="end" className="axis-text">
              {axisLabel(v)}
            </text>
          </g>
        ))}
        {dayTicks.map((d) => (
          <text key={d} x={x(d)} y={H - 6} textAnchor="middle" className="axis-text">
            {t("dayN", { n: d })}
          </text>
        ))}
        {shows("plan") && <line x1={x(1)} y1={y(planAt(1))} x2={x(days)} y2={y(planned)} className="line-plan" />}
        {shows("prev") && <path d={path(prev)} className="line-prev" />}
        {shows("current") && (
          <>
            <path d={`${path(cur)} L${x(last)} ${y(0)} L${x(1)} ${y(0)} Z`} className="area-current" />
            <path d={path(cur)} className="line-current" />
          </>
        )}
        <line x1={x(day)} x2={x(day)} y1={T} y2={H - B} className="crosshair" />
        {points.map((p) => (
          <circle key={p.s} cx={x(day)} cy={y(p.v)} r={p.s === "current" ? 4.5 : 3.5} className={`point point-${p.s}`} />
        ))}
      </svg>

      <figcaption className="legend small">
        {legend
          .filter((l) => has[l.s])
          .map((l) => (
            <button
              key={l.s}
              type="button"
              className="legend-toggle"
              aria-pressed={!hidden.has(l.s)}
              onClick={() => toggle(l.s)}
            >
              <i className={`swatch-line ${l.s}`} /> {l.label}
            </button>
          ))}
      </figcaption>
    </figure>
  );
}
