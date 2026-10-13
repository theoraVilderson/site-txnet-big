"use client";

import { useEffect, useState } from "react";
import { AlertCircle, ArrowRight, ChevronLeft } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { ResolvedGuide } from "@/lib/guide-api";
import { Skeleton } from "../kit/Skeleton";
import { GuideBlocks } from "./GuideBlocks";
import { GuideFeedback } from "./GuideFeedback";
import { useDirOf } from "../../catalog/_components/catalog-ui";

const H = FrontendI18nKeys.common.guideHelp;

type Loaded = { key: string; guides?: ResolvedGuide[]; error?: unknown };

/**
 * The guides of one slot, read once per `slotKey` (F-414-e): `null` while the
 * first answer is out, then the answer for this very slot — a switch never
 * shows the previous slot's guides under the new heading.
 */
export function useSlotGuides(slotKey: string, load: () => Promise<ResolvedGuide[]>) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    load()
      .then((guides) => alive && setLoaded({ key: slotKey, guides }))
      .catch((error) => alive && setLoaded({ key: slotKey, error }));
    return () => {
      alive = false;
    };
    // `load` is rebuilt every render; the slot is what decides a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotKey, attempt]);
  const current = loaded?.key === slotKey ? loaded : null;
  return { guides: current?.guides ?? null, error: current?.error ?? null, retry: () => setAttempt((n) => n + 1) };
}

/**
 * A slot's guides: one is shown whole; several are a list of titles, each
 * opening its guide with a way back. Nothing to show says `empty`.
 */
export function GuideList({
  guides,
  error,
  retry,
  empty,
  open,
  onOpen,
}: {
  guides: ResolvedGuide[] | null;
  error: unknown;
  retry: () => void;
  empty: string;
  /** The guide open in a list of several, by key; `null` shows the list. */
  open: string | null;
  onOpen: (key: string | null) => void;
}) {
  const { t } = useLocale();
  const guideDir = useDirOf();
  const errorMessage = useApiErrorMessage();

  if (error) {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
        <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{errorMessage(error)}</span>
        <button type="button" onClick={retry} className="shrink-0 underline">
          {t("common", H.retry)}
        </button>
      </div>
    );
  }
  if (!guides) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }
  if (guides.length === 0) return <p className="text-sm text-text-secondary">{empty}</p>;

  const shown = guides.length === 1 ? guides[0] : guides.find((g) => g.key === open);
  if (shown) {
    return (
      <article className="flex flex-col gap-3">
        {guides.length > 1 && (
          <button type="button" onClick={() => onOpen(null)} className="flex w-fit items-center gap-1 text-xs font-bold text-text-secondary hover:text-text-primary">
            <ChevronLeft size={14} className="rtl:rotate-180" aria-hidden />
            {t("common", H.back)}
          </button>
        )}
        <h3 dir={guideDir(shown.lang)} className="text-base font-bold text-text-primary">
          {shown.title}
        </h3>
        <GuideBlocks blocks={shown.blocks} dir={guideDir(shown.lang)} />
        <GuideFeedback guideKey={shown.key} />
      </article>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {guides.map((g) => (
        <li key={g.key}>
          <button
            type="button"
            onClick={() => onOpen(g.key)}
            className="flex w-full items-center gap-2 rounded-2xl border border-card-border px-3 py-3 text-start text-sm font-bold text-text-primary hover:bg-leaf-bg"
          >
            <span dir={guideDir(g.lang)} className="min-w-0 flex-1">
              {g.title}
            </span>
            <ArrowRight size={16} className="shrink-0 text-text-secondary rtl:rotate-180" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
