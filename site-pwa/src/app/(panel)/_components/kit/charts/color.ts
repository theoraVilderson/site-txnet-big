/**
 * The colour arithmetic of the chart kit (F-1001-c, panel-web
 * `contract.analytics.md` "Colour"): OKLCH lightness and chroma, WCAG contrast,
 * and the brand check the main series must pass. Pure — the colours it is
 * given come from the theme tokens and the tenant's brand at run time.
 */

/** Whether a theme is read as light or dark by the check's lightness band. */
export type ChartMode = "light" | "dark";

/** OKLCH lightness band a series must sit in, per mode (validated 2026-10-06). */
const LIGHTNESS_BAND: Record<ChartMode, readonly [number, number]> = { light: [0.43, 0.77], dark: [0.48, 0.67] };
/** Below this chroma a colour reads as grey, which is Other's. */
const CHROMA_FLOOR = 0.1;
/** A mark against the card surface: WCAG non-text contrast. */
const CONTRAST_FLOOR = 3;

const HEX = /^#([0-9a-f]{6})$/i;

/** `#rrggbb` as 0..1 channels, or null for anything else (a `var()`, an empty computed value). */
export function rgbOf(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) as [number, number, number];
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** OKLCH lightness (0..1) and chroma of an sRGB colour (Ottosson's OKLab). */
export function oklchOf(rgb: readonly [number, number, number]): { l: number; c: number } {
  const [r, g, b] = rgb.map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B) };
}

const luminance = (rgb: readonly [number, number, number]) => {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio of two sRGB colours, 1..21. */
export function contrastOf(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Whether `brand` may be the main series on `surface` (the contract's check):
 * lightness inside the mode's band, chroma at least 0.1, contrast at least
 * 3:1. A colour that cannot be read — no brand, an unresolved token — fails,
 * and the theme's accent is used instead.
 */
export function passesBrandCheck(brand: string | null, surface: string, mode: ChartMode): boolean {
  const b = brand ? rgbOf(brand) : null;
  const s = rgbOf(surface);
  if (!b || !s) return false;
  const { l, c } = oklchOf(b);
  const [low, high] = LIGHTNESS_BAND[mode];
  return l >= low && l <= high && c >= CHROMA_FLOOR && contrastOf(b, s) >= CONTRAST_FLOOR;
}

/** Steps of a sequential scale (heatmap, cohort grid): surface to full. */
export const SEQUENTIAL_STEPS = 5;

/**
 * The main series' hue in {@link SEQUENTIAL_STEPS} steps from the card surface
 * to full, as CSS: a straight OKLab mix, so lightness moves one way only.
 */
export function sequentialScale(main: string): string[] {
  return Array.from({ length: SEQUENTIAL_STEPS }, (_, i) => `color-mix(in oklab, ${main} ${Math.round(((i + 1) / SEQUENTIAL_STEPS) * 100)}%, var(--chart-surface))`);
}
