import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { h } from "./dom";
import { fmtBitRate, fmtByteRate, fmtBytes } from "./format";

import { buildSpecs } from "./chartSpecs";
import type { ChartSpec, Kind, RefLine, SeriesDef } from "./chartSpecs";
export { buildSpecs };
export type { ChartSpec, Kind, RefLine, SeriesDef };


export interface Theme {
  fg: string;
  grid: string;
  palette: string[];
  warn: string;
  crit: string;
  font: string;
}

export function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  return {
    fg: v("--fg-muted") || "#5b6470",
    grid: v("--grid") || "rgba(0,0,0,.08)",
    palette: Array.from({ length: 8 }, (_, i) => v(`--c${i + 1}`) || "#2f6fed"),
    warn: v("--warn") || "#d98a00",
    crit: v("--crit") || "#d83b3b",
    font: v("--font") || "system-ui, sans-serif",
  };
}

function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1] ?? "000000", 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Value formatting per kind
// ---------------------------------------------------------------------------

export function fmtAxis(kind: Kind, v: number): string {
  switch (kind) {
    case "percent":
      return `${Math.round(v)}%`;
    case "bytes":
      return fmtBytes(v, 0);
    case "bitrate":
      return fmtBitRate(v, true);
    case "byterate":
      return fmtByteRate(v, true);
    case "celsius":
      return `${Math.round(v)}°`;
    case "mbps":
      return `${Math.round(v)}`;
    case "ms":
      return `${Math.round(v)} ms`;
    case "count":
      return `${Math.round(v)}`;
    case "load":
      return v.toFixed(v < 10 ? 1 : 0);
  }
}

export function fmtValue(kind: Kind, v: number): string {
  switch (kind) {
    case "percent":
      return `${v.toFixed(1)}%`;
    case "celsius":
      return `${v.toFixed(1)} °C`;
    case "mbps":
      return `${v.toFixed(1)} Mbps`;
    case "ms":
      return `${v.toFixed(0)} ms`;
    case "count":
      return `${Math.round(v)}`;
    case "load":
      return v.toFixed(2);
    default:
      return fmtAxis(kind, v);
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// One chart card
// ---------------------------------------------------------------------------

const PX_HEIGHT_WIDE = 190;
const PX_HEIGHT_NARROW = 160;

export class ChartCard {
  readonly el: HTMLElement;
  readonly actions: HTMLElement;
  private readonly plotEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private plot: uPlot | null = null;
  private data: uPlot.AlignedData | null = null;
  private readonly observer: ResizeObserver;

  constructor(
    readonly spec: ChartSpec,
    private theme: Theme,
  ) {
    this.actions = h("div", { class: "card-actions" });
    this.plotEl = h("div", { class: "plot" });
    this.emptyEl = h("div", { class: "empty", hidden: true }, spec.emptyText ?? "No data in this range yet");
    this.el = h(
      "article",
      { class: "card chart", "data-chart": spec.id },
      h("header", { class: "card-head" }, h("div", null, h("h3", null, spec.title), spec.subtitle ? h("p", { class: "sub" }, spec.subtitle) : null), this.actions),
      h("div", { class: "plot-wrap" }, this.plotEl, this.emptyEl),
    );
    this.observer = new ResizeObserver(() => this.onResize());
    this.observer.observe(this.plotEl);
  }

  /** `xs` are epoch seconds; `byName` holds one aligned column per series name. */
  setData(xs: number[], byName: Map<string, Array<number | null>>): void {
    const columns = this.spec.series.map((s) => byName.get(s.name) ?? new Array<number | null>(xs.length).fill(null));
    const hasData = xs.length > 0 && columns.some((c) => c.some((v) => v !== null));
    this.emptyEl.hidden = hasData;
    this.plotEl.classList.toggle("dim", !hasData);
    this.data = [xs, ...columns] as uPlot.AlignedData;
    if (!this.plot) this.build();
    else this.plot.setData(this.data);
  }

  /** Re-create the plot, e.g. after the colour scheme changed. */
  restyle(theme: Theme): void {
    this.theme = theme;
    this.plot?.destroy();
    this.plot = null;
    if (this.data) this.build();
  }

  destroy(): void {
    this.observer.disconnect();
    this.plot?.destroy();
    this.plot = null;
    this.el.remove();
  }

  private height(): number {
    return window.innerWidth < 520 ? PX_HEIGHT_NARROW : PX_HEIGHT_WIDE;
  }

  private onResize(): void {
    const width = Math.floor(this.plotEl.clientWidth);
    if (width <= 0) return;
    if (!this.plot) {
      if (this.data) this.build();
      return;
    }
    this.plot.setSize({ width, height: this.height() });
  }

  private build(): void {
    const width = Math.floor(this.plotEl.clientWidth);
    if (width <= 0 || !this.data) return; // hidden: the ResizeObserver will call us again
    const { spec, theme } = this;

    const series: uPlot.Series[] = [
      { label: "Time" },
      ...spec.series.map((s): uPlot.Series => {
        const base = typeof s.color === "number" ? (theme.palette[s.color % theme.palette.length] ?? "#2f6fed") : s.color;
        return {
          label: s.label,
          stroke: s.alpha ? withAlpha(base, s.alpha) : base,
          width: s.width ?? 1.5,
          fill: s.fill ? withAlpha(base, 0.13) : undefined,
          spanGaps: spec.spanGaps ?? false,
          points: { show: spec.points ?? false, size: 5, fill: base, stroke: base },
          paths: s.step ? uPlot.paths.stepped?.({ align: 1 }) : undefined,
          value: (_u, v) => (v === null || v === undefined ? "—" : fmtValue(spec.kind, v)),
        };
      }),
    ];

    const axisBase = {
      stroke: theme.fg,
      font: `11px ${theme.font}`,
      grid: { stroke: theme.grid, width: 1 },
      ticks: { stroke: theme.grid, width: 1 },
    };
    const refLines = spec.refLines ?? [];

    const opts: uPlot.Options = {
      width,
      height: this.height(),
      padding: [10, 10, 0, 0],
      legend: { live: true },
      cursor: { sync: { key: "workstation" }, drag: { x: false, y: false }, y: false, points: { size: 7 } },
      scales: {
        x: { time: true },
        y: { range: (_u, min, max) => (spec.yRange ? spec.yRange(min ?? null, max ?? null) : [min ?? 0, max ?? 1]) },
      },
      axes: [
        { ...axisBase, space: 70 },
        {
          ...axisBase,
          size: 72,
          // Memory and disk sizes tick on powers of two (1, 2, 4 GiB) instead of 1.6, 3.2, ...
          ...(spec.kind === "bytes" ? { incrs: Array.from({ length: 21 }, (_, i) => 2 ** (20 + i)) } : {}),
          values: (_u, splits) => splits.map((v) => fmtAxis(spec.kind, v)),
        },
      ],
      series,
      hooks: {
        draw: [
          (u) => {
            if (refLines.length === 0) return;
            const dpr = uPlot.pxRatio;
            const { ctx } = u;
            const left = u.bbox.left;
            const right = u.bbox.left + u.bbox.width;
            ctx.save();
            ctx.setLineDash([6 * dpr, 4 * dpr]);
            ctx.lineWidth = 1.5 * dpr;
            ctx.font = `${11 * dpr}px ${theme.font}`;
            ctx.textAlign = "right";
            for (const ref of refLines) {
              const y = Math.round(u.valToPos(ref.value, "y", true));
              const color = ref.tone === "crit" ? theme.crit : theme.warn;
              ctx.strokeStyle = color;
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.moveTo(left, y);
              ctx.lineTo(right, y);
              ctx.stroke();
              ctx.fillText(ref.label, right - 4 * dpr, y - 4 * dpr);
            }
            ctx.restore();
          },
        ],
      },
    };

    this.plot = new uPlot(opts, this.data, this.plotEl);
    const rows = this.plot.root.querySelectorAll<HTMLElement>(".u-legend .u-series");
    spec.series.forEach((s, i) => {
      if (s.hideLegend) rows[i + 1]?.style.setProperty("display", "none");
    });
  }
}
