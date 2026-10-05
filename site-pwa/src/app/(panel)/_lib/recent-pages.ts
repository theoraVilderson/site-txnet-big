/**
 * The pages this device opened last (UX-1-m, `contract.ux.md` N5): history,
 * not a preference, so it stays in `localStorage` and never reaches the
 * server. The palette lists them (N6). Each row names the menu entry the page
 * sits under, so a reader labels it from the caller's visible menu — and drops
 * one the caller may no longer open. Every read and write is guarded: storage
 * may be absent or refuse (a private window).
 */
export const RECENT_PAGES_KEY = "txnet.panel.recentPages";
export const MAX_RECENT_PAGES = 10;

export interface RecentPage {
  /** The path as visited. */
  href: string;
  /** The id of the menu entry `activeHref` lit for it. */
  id: string;
}

const isRecentPage = (v: unknown): v is RecentPage =>
  typeof v === "object" && v !== null && typeof (v as RecentPage).href === "string" && typeof (v as RecentPage).id === "string";

/** Newest first; `[]` when nothing is kept or storage cannot be read. */
export function readRecentPages(): RecentPage[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_PAGES_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter(isRecentPage).slice(0, MAX_RECENT_PAGES) : [];
  } catch {
    return [];
  }
}

/** Puts `page` first, drops an older row for the same path, keeps the last 10. */
export function recordRecentPage(page: RecentPage): void {
  const next = [page, ...readRecentPages().filter((p) => p.href !== page.href)].slice(0, MAX_RECENT_PAGES);
  try {
    localStorage.setItem(RECENT_PAGES_KEY, JSON.stringify(next));
  } catch {
    // Not kept; the visit still happened.
  }
}
