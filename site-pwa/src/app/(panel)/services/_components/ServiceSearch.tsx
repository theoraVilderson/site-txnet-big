"use client";

import { useEffect, useState } from "react";
import { ClipboardPaste, Search, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const S = FrontendI18nKeys.common.myServices;

/**
 * How long typing rests before the search is written to the URL. Each write
 * is one read of billing's list, so a word is one read, not one per letter.
 */
const SEARCH_SETTLE_MS = 350;

/** Billing's own ceiling on `q` (`billing/contract.gift.md`). */
const SEARCH_MAX = 100;

/**
 * The "my services" search box (F-307-n, F-307-q). **What is typed lives
 * here**, so a letter re-renders this box and nothing else: the page and its
 * rows move only when the settled word reaches the URL.
 *
 * The page decides what counts as the URL moving on its own (back, forward, a
 * link from support) and says so through `navigations`; only then is the box
 * reset to `?q=`. Its own write landing late — or an earlier one landing while
 * a later word is typed — leaves the box alone.
 */
export function ServiceSearch({
  q,
  heading,
  navigations,
  pastedCount,
  onSettle,
  onPaste,
  onDropPaste,
}: {
  /** `?q=`, trimmed. */
  q: string;
  /** Where `?q=` is heading once the page's own writes land. */
  heading: string;
  /** Moves each time the URL moved on its own; the box then shows `q`. */
  navigations: number;
  /** How many pasted config links the page holds, `null` for none. */
  pastedCount: number | null;
  /** A settled word, for the URL. */
  onSettle: (search: string) => void;
  /** Text holding `://`: `true` when it held a config and the page took it (it then drops `?q=`). */
  onPaste: (text: string) => boolean;
  /** Typing, clearing or Escape drops the pasted links. */
  onDropPaste: () => void;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(q);
  const [seenNav, setSeenNav] = useState(navigations);
  if (navigations !== seenNav) {
    setSeenNav(navigations);
    setDraft(q);
  }

  useEffect(() => {
    const wanted = draft.trim();
    if (wanted === heading) return;
    const timer = setTimeout(() => onSettle(wanted), SEARCH_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [draft, heading, onSettle]);

  const take = (text: string): boolean => {
    if (!onPaste(text)) return false;
    setDraft("");
    return true;
  };
  const clear = () => {
    setDraft("");
    if (pastedCount != null) onDropPaste();
  };

  return (
    <div className="flex h-12 items-center gap-2 rounded-2xl border border-card-border bg-card-bg px-3.5 focus-within:border-primary">
      <Search size={18} className="shrink-0 text-text-secondary" aria-hidden />
      {pastedCount != null && (
        <span className="flex shrink-0 items-center gap-1.5 rounded-lg bg-leaf-bg px-2 py-1 text-xs font-medium text-text-primary">
          <ClipboardPaste size={14} aria-hidden />
          {t("common", S.serviceSearch.pasted, { count: pastedCount })}
        </span>
      )}
      <input
        type="search"
        value={draft}
        maxLength={SEARCH_MAX}
        // The clipboard's own text: a single-line box drops the line
        // breaks, which would run two links into one.
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (text.includes("://") && take(text)) e.preventDefault();
        }}
        onChange={(e) => {
          const value = e.target.value;
          // A link that arrived some other way (a drop) is a paste too,
          // and one that is no config is refused: `://` never reaches `?q=`.
          if (value.includes("://")) {
            take(value);
            return;
          }
          if (pastedCount != null) onDropPaste();
          setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") clear();
        }}
        placeholder={t("common", S.serviceSearch.placeholder)}
        aria-label={t("common", S.serviceSearch.label)}
        dir="auto"
        // 16px text: a phone zooms the page into any smaller input on focus.
        className="h-full min-w-0 flex-1 bg-transparent text-base text-text-primary outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {(draft !== "" || pastedCount != null) && (
        <button
          type="button"
          onClick={clear}
          aria-label={t("common", S.serviceSearch.clear)}
          title={t("common", S.serviceSearch.clear)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
        >
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}
