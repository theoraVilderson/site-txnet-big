/**
 * The pages this device opened last (UX-1-m, `contract.ux.md` N5): history,
 * not a preference, so it stays in `localStorage` and never reaches the
 * server. The palette lists them (N6). Each row names the menu entry the page
 * sits under, so a reader labels it from the caller's visible menu — and drops
 * one the caller may no longer open. Every read and write is guarded: storage
 * may be absent or refuse (a private window).
 */
import { z, type ZodType } from "zod";
import { StorageKeys, readStoredJson, writeStoredJson } from "@/lib/storage";

export const MAX_RECENT_PAGES = 10;

export interface RecentPage {
  /** The path as visited. */
  href: string;
  /** The id of the menu entry `activeHref` lit for it. */
  id: string;
}

const recentPage: ZodType<RecentPage> = z.object({ href: z.string(), id: z.string() });

/** Newest first; `[]` when nothing is kept or storage cannot be read. A malformed row is dropped, not the list. */
export function readRecentPages(): RecentPage[] {
  const rows = readStoredJson(StorageKeys.recentPages, z.array(z.unknown())) ?? [];
  return rows
    .flatMap((row) => {
      const parsed = recentPage.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, MAX_RECENT_PAGES);
}

/** Puts `page` first, drops an older row for the same path, keeps the last 10. */
export function recordRecentPage(page: RecentPage): void {
  const next = [page, ...readRecentPages().filter((p) => p.href !== page.href)].slice(0, MAX_RECENT_PAGES);
  // Refused storage keeps nothing; the visit still happened.
  writeStoredJson(StorageKeys.recentPages, next);
}
