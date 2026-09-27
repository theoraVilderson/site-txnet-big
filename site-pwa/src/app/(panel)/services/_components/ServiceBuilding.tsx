"use client";

import { Check, Loader2, PartyPopper, Server } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const S = FrontendI18nKeys.common.myServices;
const B = S.build;

type Step = "paid" | "server" | "links";
const STEPS: Step[] = ["paid", "server", "links"];

/**
 * A purchase on its way to ready (F-307-u over F-111-f / F-111-l): three
 * steps, the one in progress turning, and a sweep that never stops while
 * anything is. The user asked (2026-09-27) to *see* that something is
 * happening. The page moves it on by itself — delivery re-reads the row, a
 * capture re-reads the configs — so every sentence here says there is nothing
 * to do.
 */
export function ServiceBuilding({ stage }: { stage: "server" | "links" }) {
  const { t } = useLocale();
  const current = STEPS.indexOf(stage);

  return (
    <section className="build-card overflow-hidden rounded-2xl border border-primary/25 bg-leaf-bg p-4">
      <div className="flex items-start gap-3">
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-card-bg text-primary">
          <span className="build-orbit absolute inset-0 rounded-2xl border-2 border-primary/20 border-t-primary" aria-hidden />
          <Server size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-text-primary">{t("common", B.title)}</p>
          <p className="mt-0.5 text-xs leading-5 text-text-secondary">
            {t("common", stage === "server" ? S.preparing : B.linksHint)}
          </p>
        </div>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-card-bg" aria-hidden>
        <span className="build-sweep block h-full w-1/3 rounded-full bg-primary" />
      </div>

      <ol aria-label={t("common", B.title)} className="mt-3 grid grid-cols-3 gap-2">
        {STEPS.map((step, i) => {
          const state = i < current ? "done" : i === current ? "current" : "todo";
          return (
            <li key={step} data-step={step} data-state={state} className="flex flex-col items-center gap-1.5 text-center">
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                  state === "done"
                    ? "bg-primary text-white"
                    : state === "current"
                      ? "border-2 border-primary bg-card-bg text-primary"
                      : "border-2 border-card-border bg-card-bg text-text-secondary"
                }`}
                aria-hidden
              >
                {state === "done" ? (
                  <Check size={14} />
                ) : state === "current" ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={`text-[11px] leading-4 ${
                  state === "todo" ? "text-text-secondary" : "font-bold text-text-primary"
                }`}
              >
                {t("common", B[step])}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The moment a purchase this page watched turns usable. */
export function ServiceReady() {
  const { t } = useLocale();
  return (
    <p role="status" className="pay-pop-in flex items-center gap-3 rounded-2xl border border-primary/25 bg-leaf-bg px-3 py-2.5 text-sm font-bold text-primary">
      <PartyPopper size={18} className="shrink-0" aria-hidden />
      {t("common", B.ready)}
    </p>
  );
}
