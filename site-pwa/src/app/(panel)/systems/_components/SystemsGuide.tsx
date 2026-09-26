"use client";

import Link from "next/link";
import { BookOpen, Check, ChevronDown, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { PANEL_CATALOG } from "@/lib/routes";
import type { GuideStep, StepState } from "../_lib/systems-guide";
import { SYSTEMS_KEYS } from "../_lib/systems";

const K = SYSTEMS_KEYS.guide;

const GLOSSARY = ["panel", "test", "inbound", "group", "shared", "drain"] as const;

const STEP_LOOK: Record<StepState, { card: string; badge: string }> = {
  done: { card: "border-primary/20 bg-card-bg", badge: "bg-primary text-text-on-accent" },
  current: { card: "border-primary bg-card-bg shadow-md", badge: "bg-primary text-text-on-accent" },
  todo: { card: "border-card-border bg-card-bg opacity-75", badge: "bg-bg-inner text-text-secondary" },
};

/**
 * The four steps from nothing to a sale (F-027-ck), each ticked by what the
 * page read (`guideOf`), the next one's button leading to where it is done,
 * and the page's words explained once. Closing it is remembered per browser.
 */
export function SystemsGuide({
  steps,
  done,
  onStep,
  onClose,
}: {
  steps: { step: GuideStep; state: StepState }[];
  done: boolean;
  /** register opens the wizard; accepted and group switch the tab. product is a link. */
  onStep: (step: Exclude<GuideStep, "product">) => void;
  onClose: () => void;
}) {
  const { lang, t } = useLocale();
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-card-border bg-[var(--leaf-bg)] p-4 sm:p-5">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-bold text-text-primary">
            <BookOpen size={16} className="text-primary" aria-hidden />
            {t("common", K.title)}
          </h2>
          <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", done ? K.allDone : K.intro)}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("common", K.hide)} title={t("common", K.hide)} className="rounded-lg p-1 text-text-secondary hover:text-text-primary">
          <X size={16} aria-hidden />
        </button>
      </header>

      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map(({ step, state }, i) => (
          <li key={step} className={`flex flex-col gap-2 rounded-2xl border p-3 ${STEP_LOOK[state].card}`}>
            <div className="flex items-center gap-2">
              <span className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${STEP_LOOK[state].badge}`}>
                {state === "done" ? <Check size={13} aria-hidden /> : (i + 1).toLocaleString(lang)}
              </span>
              <p className="min-w-0 text-xs font-bold text-text-primary">{t("common", K.steps[step].title)}</p>
            </div>
            <p className="text-[11px] leading-5 text-text-secondary">{t("common", K.steps[step].body)}</p>
            <div className="mt-auto flex items-center justify-between gap-2">
              <span className={`text-[10px] font-bold ${state === "todo" ? "text-text-secondary" : "text-primary"}`}>{t("common", K.state[state])}</span>
              {state === "current" &&
                (step === "product" ? (
                  <Link href={PANEL_CATALOG} className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-bold text-text-on-accent">
                    {t("common", K.steps.product.action)}
                  </Link>
                ) : (
                  <button type="button" onClick={() => onStep(step)} className="rounded-lg bg-primary px-2.5 py-1 text-[11px] font-bold text-text-on-accent">
                    {t("common", K.steps[step].action)}
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ol>

      <details className="group rounded-2xl border border-card-border bg-card-bg">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-bold text-text-primary">
          {t("common", K.glossary.title)}
          <ChevronDown size={14} className="text-text-secondary transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <dl className="grid gap-3 border-t border-card-border p-3 sm:grid-cols-2">
          {GLOSSARY.map((term) => (
            <div key={term}>
              <dt className="text-xs font-bold text-primary">{t("common", K.glossary[term].term)}</dt>
              <dd className="mt-0.5 text-[11px] leading-5 text-text-secondary">{t("common", K.glossary[term].body)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
