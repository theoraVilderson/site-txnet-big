/**
 * The categorical slots (F-1001-c, panel-web `contract.analytics.md`
 * "Colour"): eight theme tokens, `--chart-1`…`--chart-8` in `globals.css`, in
 * the validated order. A ninth series is never a new hue — it folds into
 * Other, which is always the neutral `--chart-other`.
 */

export const CHART_SLOTS = 8;

/** The token of slot `index` (0-based); past the last, Other's. */
export function slotColor(index: number): string {
  return index >= 0 && index < CHART_SLOTS ? `var(--chart-${index + 1})` : CHART_OTHER;
}

export const CHART_OTHER = "var(--chart-other)";
/** The previous period: the same shape, muted and dashed, under the current one (rule 2). */
export const CHART_MUTED = "var(--chart-muted)";
export const CHART_GRID = "var(--chart-grid)";
/** The previous period's dash (rule 2). */
export const PREVIOUS_DASH = "4 3";

/**
 * Colour follows the entity, never its rank (rule 3): each id keeps the slot
 * of its place in `catalogOrder` — the catalog's own order — in every chart
 * and whatever a filter removes. An id past the eighth, or not in the order,
 * is Other.
 */
export function slotsByEntity(catalogOrder: readonly string[]): (id: string) => string {
  const slots = new Map(catalogOrder.map((id, i) => [id, slotColor(i)]));
  return (id) => slots.get(id) ?? CHART_OTHER;
}
