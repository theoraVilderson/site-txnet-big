"use client";

import { Check } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { cn } from "../../_components/kit/cn";
import { SHOP_STEPS } from "../_lib/shop";

const K = FrontendI18nKeys.common.shop.steps;

/**
 * The shop's three steps (UX-1-aa, `contract.ux.md` U1): choose, invoice and
 * pay, delivered. `current` comes from the page's phase (`shopStep`); a step
 * behind it is done and carries a check, the current one is `aria-current`.
 */
export function ShopSteps({ current }: { current: number }) {
  const { t } = useLocale();
  return (
    <ol aria-label={t("common", K.label)} className="flex items-center gap-2">
      {SHOP_STEPS.map((step, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li
            key={step}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <span
              aria-hidden
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-bold transition-colors duration-300",
                state === "done" && "border-primary bg-primary text-on-accent",
                state === "current" && "border-primary bg-leaf-bg text-primary",
                state === "todo" && "border-card-border text-text-secondary",
              )}
            >
              {state === "done" ? <Check size={14} /> : i + 1}
            </span>
            <span className={cn("truncate text-xs font-bold", state === "todo" ? "text-text-secondary" : "text-text-primary")}>
              {t("common", K[step])}
            </span>
            {i < SHOP_STEPS.length - 1 && (
              <span aria-hidden className={cn("h-px flex-1 transition-colors duration-300", i < current ? "bg-primary" : "bg-card-border")} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
