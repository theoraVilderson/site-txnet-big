/** A gap in the page list, rendered as an ellipsis. */
export const PAGE_GAP = "gap" as const;

export type PageItem = number | typeof PAGE_GAP;

/**
 * The pages a pagination bar shows (F-093-b): every page up to seven, else the
 * first, the last and a window around the current one. Always at most seven
 * items, so the bar does not change width as the user pages through.
 */
export function pageItems(current: number, total: number): PageItem[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (current <= 3) return [1, 2, 3, 4, PAGE_GAP, total];
  if (current >= total - 2) return [1, PAGE_GAP, total - 3, total - 2, total - 1, total];
  return [1, PAGE_GAP, current - 1, current, current + 1, PAGE_GAP, total];
}

/** The 1-based range of items a page shows: page 2 of 10 per page -> 11..20. */
export function pageRange(page: number, pageSize: number, totalItems: number) {
  return {
    from: totalItems === 0 ? 0 : (page - 1) * pageSize + 1,
    to: Math.min(page * pageSize, totalItems),
  };
}
