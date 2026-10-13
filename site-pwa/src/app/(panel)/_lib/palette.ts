import type { LucideIcon } from "lucide-react";
import { toEnglishDigits } from "@/util/helper";

/**
 * The command palette's matching (UX-1-n, `contract.ux.md` N6). Pure, so the
 * rules are tested without a screen.
 */

/** Arabic letters a Persian keyboard does not type, folded into the Persian ones. */
const LETTERS: Record<string, string> = { "ي": "ی", "ى": "ی", "ك": "ک" };

/**
 * What both sides of a match are reduced to: lower case, Arabic ي/ى/ك as
 * Persian ی/ک, Persian (۰–۹) and Arabic (٠–٩) digits as Latin, the zero-width
 * non-joiner dropped (so "جستوجو" finds "جست‌وجو"), runs of space as one.
 */
export function foldForSearch(text: string): string {
  return toEnglishDigits(text)
    .toLowerCase()
    .replace(/[يىك]/g, (c) => LETTERS[c])
    .replace(/‌/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How well `query` matches the best of `haystacks` — the labels of one entry,
 * in the current language and English. 0 is no match: every word of the
 * query must be in one label. A word at a label's start counts 3, at a word's
 * start 2, anywhere else 1.
 */
export function matchScore(query: string, haystacks: readonly string[]): number {
  const words = foldForSearch(query).split(" ").filter(Boolean);
  if (words.length === 0) return 0;
  let best = 0;
  for (const raw of haystacks) {
    const hay = foldForSearch(raw);
    let score = 0;
    for (const word of words) {
      const at = hay.indexOf(word);
      if (at < 0) {
        score = 0;
        break;
      }
      score += at === 0 ? 3 : /[\s›.:|/-]/.test(hay[at - 1]) ? 2 : 1;
    }
    best = Math.max(best, score);
  }
  return best;
}

/** `services`, `tickets` and `users` are data, found by their sources (UX-1-o); the rest is matched here. */
export type PaletteGroup = "recent" | "pages" | "services" | "tickets" | "users" | "settings" | "actions";
export type PaletteDataGroup = Extract<PaletteGroup, "services" | "tickets" | "users">;
export const PALETTE_DATA_GROUPS: readonly PaletteDataGroup[] = ["services", "tickets", "users"];

/** The order groups are drawn in, which is also the order the arrows walk. */
export const PALETTE_GROUPS: readonly PaletteGroup[] = ["recent", "pages", "services", "tickets", "users", "settings", "actions"];

/** At most this many per group while a query is typed. */
export const PALETTE_GROUP_LIMIT = 8;

export interface PaletteItem {
  /** Unique in the list; the option's DOM id is built on it. */
  key: string;
  group: PaletteGroup;
  label: string;
  /** A second, quieter line: the group a page sits in. */
  hint?: string;
  icon?: LucideIcon;
  /** Every label it is found by — the current language's and English. */
  haystacks: readonly string[];
  /** Where Enter goes; or */
  href?: string;
  /** what Enter does. */
  run?: () => void;
  /** A menu entry's id: Shift+Enter pins or unpins it (N5). */
  pinId?: string;
}

/**
 * The items to draw for `query`, in `PALETTE_GROUPS` order. Empty, it is the
 * recent pages and the pages as they stand; typed, recent pages step aside
 * (the pages themselves are found) and each group is its best matches, at
 * most `PALETTE_GROUP_LIMIT`, ties in their own order. A data group's items
 * were matched by their source, and are kept as it answered.
 */
export function paletteResults(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const typed = foldForSearch(query) !== "";
  return PALETTE_GROUPS.flatMap((group) => {
    const own = items.filter((i) => i.group === group);
    if (!typed) return group === "recent" || group === "pages" ? own : [];
    if (group === "recent") return [];
    if ((PALETTE_DATA_GROUPS as readonly PaletteGroup[]).includes(group)) return own.slice(0, PALETTE_GROUP_LIMIT);
    return own
      .map((item, i) => ({ item, i, score: matchScore(query, item.haystacks) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, PALETTE_GROUP_LIMIT)
      .map((r) => r.item);
  });
}
