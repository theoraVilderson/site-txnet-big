"use client";

import { useEffect, useState } from "react";
import { AlertCircle, ArrowRight, ChevronLeft, Search, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { guideReadApi, type GuideHit, type ResolvedGuide } from "@/lib/guide-api";
import { Skeleton } from "../kit/Skeleton";
import { GuideBlocks } from "./GuideBlocks";
import { GuideFeedback } from "./GuideFeedback";
import { useDirOf } from "../../catalog/_components/catalog-ui";

const H = FrontendI18nKeys.common.guideHelp;

/** Typing rests this long before a search is sent: one request per pause, not per key. */
const REST_MS = 300;
/** tenant-service's own floor (`guideSearchQuerySchema`). */
export const GUIDE_SEARCH_MIN = 2;

/** The search box (F-414-j): controlled, so the sheet decides what shows under it. */
export function GuideSearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useLocale();
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-card-border bg-bg-inner px-3 focus-within:border-primary">
      <Search size={16} className="shrink-0 text-text-secondary" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("common", H.search.placeholder)}
        aria-label={t("common", H.search.label)}
        maxLength={100}
        dir="auto"
        className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-text-primary outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value !== "" && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={t("common", H.search.clear)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
        >
          <X size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}

type Answer = { q: string; hits?: GuideHit[]; error?: unknown };

/**
 * The hits for `query` once typing rests (F-414-j), each opening its guide
 * with a way back. An answer is shown only under the query it was asked for.
 */
export function GuideSearchResults({ query }: { query: string }) {
  const { t } = useLocale();
  const guideDir = useDirOf();
  const errorMessage = useApiErrorMessage();
  const q = query.trim();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [open, setOpen] = useState<{ key: string; guide?: ResolvedGuide; error?: unknown } | null>(null);

  useEffect(() => {
    if (q.length < GUIDE_SEARCH_MIN) return;
    let alive = true;
    const timer = setTimeout(() => {
      guideReadApi
        .search(q)
        .then((hits) => alive && setAnswer({ q, hits }))
        .catch((error) => alive && setAnswer({ q, error }));
    }, REST_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  function openHit(key: string) {
    setOpen({ key });
    guideReadApi
      .one(key)
      .then((guide) => setOpen((o) => (o?.key === key ? { key, guide } : o)))
      .catch((error) => setOpen((o) => (o?.key === key ? { key, error } : o)));
  }

  if (open) {
    return (
      <article className="flex flex-col gap-3">
        <button type="button" onClick={() => setOpen(null)} className="flex w-fit items-center gap-1 text-xs font-bold text-text-secondary hover:text-text-primary">
          <ChevronLeft size={14} className="rtl:rotate-180" aria-hidden />
          {t("common", H.back)}
        </button>
        {open.error ? (
          <Failure text={errorMessage(open.error)} />
        ) : !open.guide ? (
          <Loading />
        ) : (
          <>
            <h3 dir={guideDir(open.guide.lang)} className="text-base font-bold text-text-primary">
              {open.guide.title}
            </h3>
            <GuideBlocks blocks={open.guide.blocks} dir={guideDir(open.guide.lang)} />
            <GuideFeedback guideKey={open.guide.key} />
          </>
        )}
      </article>
    );
  }

  if (q.length < GUIDE_SEARCH_MIN) return <p className="text-xs text-text-secondary">{t("common", H.search.tooShort)}</p>;
  const current = answer?.q === q ? answer : null;
  if (!current) return <Loading />;
  if (current.error) return <Failure text={errorMessage(current.error)} />;
  if (!current.hits?.length) return <p className="text-sm text-text-secondary">{t("common", H.search.none, { q })}</p>;

  return (
    <ul className="flex flex-col gap-2" aria-live="polite">
      {current.hits.map((hit) => (
        <li key={hit.key}>
          <button
            type="button"
            onClick={() => openHit(hit.key)}
            className="flex w-full items-center gap-2 rounded-2xl border border-card-border px-3 py-3 text-start hover:bg-leaf-bg"
          >
            <span dir={guideDir(hit.lang)} className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-bold text-text-primary">{hit.title}</span>
              {hit.snippet && <span className="line-clamp-2 text-xs text-text-secondary">{hit.snippet}</span>}
            </span>
            <ArrowRight size={16} className="shrink-0 text-text-secondary rtl:rotate-180" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-full" />
    </div>
  );
}

function Failure({ text }: { text: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
      <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  );
}
