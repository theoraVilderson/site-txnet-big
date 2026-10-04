"use client";

import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { guideFeedbackApi, guideReadApi } from "@/lib/guide-api";

const F = FrontendI18nKeys.common.guideHelp.feedback;

/** `undefined` while the user's own vote is read; `"none"` when there is no way to vote (not signed in, or the read failed). */
type Vote = boolean | null | "none" | undefined;

/**
 * Under a guide shown whole (F-414-l, ADR-0119): reports the view, which the
 * server counts once a day per viewer, and asks a signed-in user whether it
 * helped. One vote per user per guide, changeable. A visitor who cannot vote
 * sees nothing here rather than a button that fails.
 */
export function GuideFeedback({ guideKey }: { guideKey: string }) {
  const { t } = useLocale();
  const [vote, setVote] = useState<Vote>(undefined);
  const [just, setJust] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setVote(undefined);
    setJust(false);
    setFailed(false);
    // Nothing is shown for a view: it is counted or not, and the reader is not told.
    guideReadApi.view(guideKey).catch(() => undefined);
    guideFeedbackApi
      .mine(guideKey)
      .then((r) => alive && setVote(r.helpful))
      .catch(() => alive && setVote("none"));
    return () => {
      alive = false;
    };
  }, [guideKey]);

  if (vote === undefined || vote === "none") return null;

  async function cast(helpful: boolean) {
    setBusy(true);
    setFailed(false);
    try {
      const r = await guideFeedbackApi.vote(guideKey, helpful);
      setVote(r.helpful);
      setJust(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const button = (helpful: boolean) => {
    const on = vote === helpful;
    const Icon = helpful ? ThumbsUp : ThumbsDown;
    return (
      <button
        type="button"
        disabled={busy}
        aria-pressed={on}
        onClick={() => cast(helpful)}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold transition-colors disabled:opacity-60 ${
          on ? "border-primary bg-leaf-bg text-primary" : "border-card-border text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
        }`}
      >
        <Icon size={14} aria-hidden />
        {t("common", helpful ? F.yes : F.no)}
      </button>
    );
  };

  return (
    <section className="mt-2 flex flex-col gap-2 border-t border-card-border pt-3" aria-label={t("common", F.question)}>
      <p className="text-xs font-bold text-text-primary">{just ? t("common", F.thanks) : vote === null ? t("common", F.question) : t("common", F.change)}</p>
      <div className="flex flex-wrap gap-2">
        {button(true)}
        {button(false)}
      </div>
      {failed && (
        <p role="alert" className="text-xs font-medium text-error">
          {t("common", F.failed)}
        </p>
      )}
    </section>
  );
}
