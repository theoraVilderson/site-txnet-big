import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { CalendarHeatmap, ChartCard, DeltaPill, StackedColumns, TrendChart, slotColor } from ".";
import { barRows } from "./BarList";
import { heatStep, weeksOf } from "./CalendarHeatmap";
import { THEME_ACCENT, contrastOf, mainSeriesOf, oklchOf, passesBrandCheck, rgbOf, sequentialScale } from "./color";
import { CHART_OTHER, slotsByEntity } from "./palette";
import { xTickIndexes, yScaleOf, yTicks } from "./plot";
import { stacked } from "./StackedColumns";

/**
 * The chart kit (F-1001-c, panel-web `contract.analytics.md` "Chart kit").
 * What a page inherits from it, so what this holds is the contract's rules,
 * not the pixels:
 *
 * - the palette in `globals.css` is the validated table, slot for slot, in
 *   every theme — a change re-runs the validator and updates the contract;
 * - the brand is the main series only if it passes the check on the theme's
 *   surface: a pale brand and a dark red one fail it, the light accent passes;
 * - colour follows the entity, never its rank (rule 3), and a ninth is Other;
 * - the sequential scale moves lightness one way; Other is grey;
 * - a bar list is the top seven and one Other (rule 3);
 * - a y axis starts at 0 with at most five ticks (rule 7);
 * - a delta is never colour alone, and `new` from zero (rule 4);
 * - every chart has its table view, and a card fails alone with its retry (rules 6, 11).
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));
vi.mock("@/context/ThemeContext", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@/context/BrandContext", () => ({ useBrandColor: () => null }));
// jsdom lays nothing out: the plots are drawn at a phone's width (rule 12).
vi.mock("@visx/responsive", () => ({ ParentSize: ({ children }: { children: (s: { width: number; height: number }) => unknown }) => children({ width: 360, height: 220 }) }));

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", isRtl: false, t: (_ns: string, key: string, vars?: Record<string, unknown>) => (vars?.value ? `${key}:${vars.value}` : key) } as unknown as ReturnType<typeof useLocale>);
});

const CSS = readFileSync(join(__dirname, "../../../../globals.css"), "utf8");
const themeBlock = (name: string) => {
  const at = CSS.indexOf(`[data-theme="${name}"] {`);
  return CSS.slice(at, CSS.indexOf("\n  }\n", at));
};
const token = (block: string, name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1].trim();

/** The contract's table (validated 2026-10-06): light, then dark and ocean. */
const LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

describe("the palette", () => {
  it("is the validated table, slot for slot, in every theme", () => {
    for (const [theme, slots] of [["light", LIGHT], ["dark", DARK], ["ocean", DARK]] as const) {
      expect(slots.map((_, i) => token(themeBlock(theme), `chart-${i + 1}`)), theme).toEqual(slots);
      for (const name of ["chart-surface", "chart-accent", "chart-other", "chart-muted", "chart-grid"]) expect(token(themeBlock(theme), name), `${theme} ${name}`).toBeTruthy();
    }
  });

  it("keeps the theme's own accent apart from --accent-primary, which a brand overrides", () => {
    for (const theme of ["light", "dark", "ocean"]) expect(token(themeBlock(theme), "chart-accent")).toBe(token(themeBlock(theme), "accent-primary"));
  });

  it("passes the dark themes' slots on their surface at 3:1, as the table says", () => {
    for (const theme of ["dark", "ocean"]) {
      const surface = rgbOf(token(themeBlock(theme), "chart-surface") ?? "");
      for (const hex of DARK) expect(contrastOf(rgbOf(hex)!, surface!), `${theme} ${hex}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("the brand check", () => {
  const surface = (theme: string) => token(themeBlock(theme), "chart-surface") ?? "";

  it("passes the light theme's accent and a mid blue brand on every theme", () => {
    expect(passesBrandCheck(token(themeBlock("light"), "chart-accent") ?? "", surface("light"), "light")).toBe(true);
    for (const theme of ["dark", "ocean"]) expect(passesBrandCheck("#3987e5", surface(theme), "dark"), theme).toBe(true);
  });

  it("fails a pale brand and a dark red one, and anything it cannot read", () => {
    expect(passesBrandCheck("#f3e8ff", surface("light"), "light")).toBe(false);
    expect(passesBrandCheck("#7a0d0d", surface("light"), "light")).toBe(false);
    expect(passesBrandCheck("#7a0d0d", surface("dark"), "dark")).toBe(false);
    expect(passesBrandCheck(null, surface("light"), "light")).toBe(false);
    expect(passesBrandCheck("#2a78d6", "", "light")).toBe(false);
  });

  it("draws the brand, else the theme's accent, else slot 1 — never a fallback that fails the check (user, 2026-10-15)", () => {
    const at = (theme: string, brand: string | null) =>
      mainSeriesOf({ brand, accent: token(themeBlock(theme), "chart-accent") ?? "", surface: surface(theme), mode: theme === "light" ? "light" : "dark" });
    expect(at("light", "#3987e5")).toBe("#3987e5");
    expect(at("light", null)).toBe(THEME_ACCENT);
    expect(at("light", "#f3e8ff")).toBe(THEME_ACCENT);
    // The dark accent is too light for a series, ocean's too grey: slot 1.
    expect(at("dark", null)).toBe(slotColor(0));
    expect(at("ocean", "#7a0d0d")).toBe(slotColor(0));
    expect(at("dark", "#3987e5")).toBe("#3987e5");
    // Before the page is styled nothing can be checked.
    expect(mainSeriesOf({ brand: "#3987e5", accent: "", surface: "", mode: "dark" })).toBe(THEME_ACCENT);
  });

  it("reads OKLCH as the validator does", () => {
    const { l, c } = oklchOf(rgbOf("#2a78d6")!);
    expect(l).toBeGreaterThan(0.43);
    expect(l).toBeLessThan(0.77);
    expect(c).toBeGreaterThan(0.1);
  });
});

describe("colour follows the entity", () => {
  it("keeps each id's slot whatever else is drawn, and folds a ninth into Other", () => {
    const order = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const of = slotsByEntity(order);
    expect(of("c")).toBe(slotColor(2));
    expect(["c", "a"].map(of)).toEqual([slotColor(2), slotColor(0)]);
    expect(of("i")).toBe(CHART_OTHER);
    expect(of("unknown")).toBe(CHART_OTHER);
  });

  it("steps the sequential scale from the surface to full, one way only", () => {
    const steps = sequentialScale("var(--chart-accent)");
    expect(steps).toHaveLength(5);
    const shares = steps.map((s) => Number(/ (\d+)%/.exec(s)?.[1]));
    expect(shares).toEqual([...shares].sort((a, b) => a - b));
    expect(shares.at(-1)).toBe(100);
  });
});

describe("shapes", () => {
  it("lists the top seven and one Other holding the rest", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, label: `P${i}`, value: i + 1 }));
    const rows = barRows(items, "Other");
    expect(rows).toHaveLength(8);
    expect(rows[0].id).toBe("p9");
    expect(rows[7]).toMatchObject({ id: "other", value: 1 + 2 + 3, color: CHART_OTHER });
  });

  it("starts the y axis at 0 with at most five ticks, and labels a long time axis sparsely", () => {
    const y = yScaleOf([120, 340, 90], 200);
    expect(y.domain()[0]).toBe(0);
    expect(y.ticks(5).length).toBeGreaterThan(5);
    expect(yTicks(y).length).toBeLessThanOrEqual(5);
    expect(yTicks(y)[0]).toBe(0);
    const ticks = xTickIndexes(90, 360);
    expect(ticks[0]).toBe(0);
    expect(ticks.length).toBeLessThanOrEqual(6);
  });

  it("starts a Jalali week on Saturday and puts no colour on an empty day", () => {
    // 2026-10-15 is a Thursday: five cells of padding above it in a Saturday week.
    const days = ["2026-10-15", "2026-10-16", "2026-10-17"].map((day) => ({ day, value: 1 }));
    expect(weeksOf(days, 6).map(({ col, row }) => [col, row])).toEqual([[0, 5], [0, 6], [1, 0]]);
    expect(heatStep(0, 10)).toBeNull();
    expect(heatStep(null, 10)).toBeNull();
    expect(heatStep(10, 10)).toBe(4);
    expect(heatStep(1, 10)).toBe(0);
  });
});

describe("DeltaPill", () => {
  it("says the change in words and an arrow, `new` from zero, and nothing with nothing compared", () => {
    const { container, rerender } = render(<DeltaPill delta={0.25} />);
    expect(screen.getByText(/kit\.chart\.up:25%/)).toBeTruthy();
    expect(screen.getByText("kit.chart.vsPrevious")).toBeTruthy();
    expect(container.querySelector("svg")).toBeTruthy();
    rerender(<DeltaPill delta="new" />);
    expect(screen.getByText("kit.chart.new")).toBeTruthy();
    rerender(<DeltaPill delta={-0.1} downIsGood bare />);
    expect(screen.getByText(/kit\.chart\.down:10%/).closest("span[class*='text-success']")).toBeTruthy();
    rerender(<DeltaPill delta={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("ChartCard", () => {
  const table = { columns: [{ id: "x", header: "Day", cell: (r: { day: string }) => r.day }], rows: [{ day: "2026-10-01" }], rowKey: (r: { day: string }) => r.day };

  it("toggles to its table view, the exact numbers", () => {
    render(<ChartCard title="Net sales" table={table}><div data-testid="plot" /></ChartCard>);
    expect(screen.getByTestId("plot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "kit.chart.showTable" }));
    expect(screen.queryByTestId("plot")).toBeNull();
    expect(screen.getAllByText("2026-10-01").length).toBeGreaterThan(0);
  });

  it("fails alone with its own retry, and keeps the old chart at half strength while new figures load", () => {
    const onRetry = vi.fn();
    const { rerender, container } = render(<ChartCard title="Net sales" table={table} state="error" onRetry={onRetry}><div data-testid="plot" /></ChartCard>);
    fireEvent.click(screen.getByRole("button", { name: "kit.chart.retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<ChartCard title="Net sales" table={table} stale><div data-testid="plot" /></ChartCard>);
    expect(screen.getByTestId("plot").parentElement?.className).toContain("opacity-50");
    expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
  });

  it("shows a legend only for two or more series", () => {
    const { rerender } = render(<ChartCard title="t" table={table} legend={[{ id: "a", label: "Alpha", color: slotColor(0) }]}><div /></ChartCard>);
    expect(screen.queryByText("Alpha")).toBeNull();
    rerender(<ChartCard title="t" table={table} legend={[{ id: "a", label: "Alpha", color: slotColor(0) }, { id: "b", label: "Beta", color: slotColor(1) }]}><div /></ChartCard>);
    expect(screen.getByText("Alpha")).toBeTruthy();
  });
});

describe("the plots", () => {
  const x = ["1 Oct", "2 Oct", "3 Oct"];

  it("runs time left to right in every language, and walks its points with the arrow keys, the tooltip following", () => {
    vi.mocked(useLocale).mockReturnValue({ lang: "fa", isRtl: true, t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
    const { container } = render(<TrendChart label="Net sales" x={x} series={[{ id: "net", label: "Net", values: [10, 30, 20] }]} previous={[5, 0, 20]} variant="area" />);
    expect(container.firstElementChild?.getAttribute("dir")).toBe("ltr");
    const plot = screen.getByRole("img", { name: "kit.chart.chart" });
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    fireEvent.keyDown(plot, { key: "ArrowRight" });
    const tip = screen.getByRole("status");
    expect(tip.textContent).toContain("2 Oct");
    expect(tip.getAttribute("dir")).toBe("rtl");
    // Previous was 0: the change is `new`, never Infinity.
    expect(tip.textContent).toContain("kit.chart.new");
    fireEvent.keyDown(plot, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stacks parts from 0, and draws a column per bucket", () => {
    expect(stacked([{ id: "a", label: "A", values: [2] }, { id: "b", label: "B", values: [-1] }, { id: "c", label: "C", values: [3] }], 0)).toEqual([{ from: 0, to: 2 }, { from: 2, to: 2 }, { from: 2, to: 5 }]);
    const { container } = render(<StackedColumns label="New vs returning" x={x} series={[{ id: "n", label: "New", values: [1, 2, 3] }, { id: "r", label: "Returning", values: [3, 0, 1] }]} />);
    expect(container.querySelectorAll("rect[fill^='var(--chart-']").length).toBe(5);
  });

  it("draws one cell per day, and only the last 13 weeks below md", () => {
    const days = Array.from({ length: 200 }, (_, i) => ({ day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), value: i % 3 }));
    const { container } = render(<CalendarHeatmap label="Net per day" days={days} weekStartsOn={1} formatDay={(d) => d} />);
    expect(container.querySelectorAll("svg rect").length).toBe(13 * 7);
  });
});

