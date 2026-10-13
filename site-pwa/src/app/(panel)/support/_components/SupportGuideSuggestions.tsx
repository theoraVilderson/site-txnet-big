"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BookOpen, ChevronDown } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { guideReadApi, type ResolvedGuide } from "@/lib/guide-api";
import { GuideBlocks } from "../../_components/guide/GuideBlocks";
import { GuideFeedback } from "../../_components/guide/GuideFeedback";
import { useSlotGuides } from "../../_components/guide/GuideList";
import { useDirOf } from "../../catalog/_components/catalog-ui";
import { supportGuideQuery } from "../../_lib/guide-help";

const H = FrontendI18nKeys.common.guideHelp;

/** Typing rests this long before the message is matched: one request per pause. */
const REST_MS = 500;
/** As many as fit above the form without pushing it off a phone screen. */
const SHOWN = 3;

type Offered = { key: string; lang: string; title: string };

/**
 * "These guides may answer it", above a new support conversation (F-414-k):
 * the guides placed on the support section first, then — once typing rests —
 * the ones the subject and message match (`suggest`, any word). Each opens in
 * place. An offer, never a gate: nothing here stops the form being sent, and
 * a failed read shows nothing rather than an error over the form. `empty` is
 * what stands in when nothing is offered (the new ticket's last step, UX-1-w).
 */
export function SupportGuideSuggestions({ subject, body, empty = null }: { subject: string; body: string; empty?: ReactNode }) {
  const { t } = useLocale();
  const placed = useSlotGuides("route:support", () => guideReadApi.forSlot("route", "support"));
  const q = supportGuideQuery(subject, body);
  const [matched, setMatched] = useState<{ q: string; hits: Offered[] } | null>(null);

  useEffect(() => {
    if (!q) return;
    let alive = true;
    const timer = setTimeout(() => {
      guideReadApi
        .suggest(q)
        .then((hits) => alive && setMatched({ q, hits }))
        .catch(() => alive && setMatched({ q, hits: [] }));
    }, REST_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [q]);

  const hits = q && matched?.q === q ? matched.hits : [];
  const offered: Offered[] = (hits.length > 0 ? hits : (placed.guides ?? [])).slice(0, SHOWN);
  if (offered.length === 0) return <>{empty}</>;

  return (
    <section aria-label={t("common", H.beforeSupport.title)} className="space-y-2 rounded-2xl border border-primary/40 bg-leaf-bg p-3">
      <p className="flex items-center gap-2 text-xs font-bold text-text-primary">
        <BookOpen size={14} aria-hidden />
        {t("common", hits.length > 0 ? H.beforeSupport.matched : H.beforeSupport.title)}
      </p>
      <ul className="space-y-2">
        {offered.map((g) => (
          <OfferedGuide key={g.key} guide={g} placed={placed.guides?.find((p) => p.key === g.key)} />
        ))}
      </ul>
      <p className="text-[11px] text-text-secondary">{t("common", H.beforeSupport.stillSend)}</p>
    </section>
  );
}

/** One offered guide: its title, opening to its text in place (read by key unless the slot already brought it). */
function OfferedGuide({ guide, placed }: { guide: Offered; placed?: ResolvedGuide }) {
  const guideDir = useDirOf();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<ResolvedGuide | null>(placed ?? null);

  function toggle() {
    setOpen((o) => !o);
    if (!loaded) guideReadApi.one(guide.key).then(setLoaded).catch(() => undefined);
  }

  return (
    <li className="rounded-xl border border-card-border bg-card-bg">
      <button type="button" onClick={toggle} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm font-bold text-text-primary">
        <span dir={guideDir(guide.lang)} className="min-w-0 flex-1">
          {guide.title}
        </span>
        <ChevronDown size={14} className={`shrink-0 text-text-secondary ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && loaded && (
        <div className="border-t border-card-border px-3 py-3">
          <GuideBlocks blocks={loaded.blocks} dir={guideDir(loaded.lang)} />
          <GuideFeedback guideKey={loaded.key} />
        </div>
      )}
    </li>
  );
}
