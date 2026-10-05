"use client";

import Link from "next/link";
import { Gift } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { wheelApi, type UserWheel } from "@/lib/engagement-api";
import { PANEL_WHEEL } from "@/lib/routes";
import { formatInstant } from "../../../_lib/datetime";
import { refusalKeyOf } from "../../../wheel/_lib/wheel";
import { EmptyState } from "../../kit";
import { useWidgetSource } from "../useWidgetSource";
import { WidgetBody } from "../WidgetFrame";

const D = FrontendI18nKeys.common.dashboard;
const K = FrontendI18nKeys.common.wheel;

/**
 * The wheel (UX-1-q, D4): whether a spin is open today. No wheel running is
 * billing's `no_wheel`, read here as nothing to show rather than a failure.
 */
export default function WheelWidget() {
  const { t, lang } = useLocale();
  const source = useWidgetSource("wheel", async (): Promise<UserWheel | null> => {
    try {
      return await wheelApi.view();
    } catch (e) {
      if ((e as { reason?: unknown } | null)?.reason === "no_wheel") return null;
      throw e;
    }
  });
  return (
    <WidgetBody source={source} isEmpty={(w) => w === null} empty={<EmptyState icon={Gift} title={t("common", K.noWheel)} className="py-4" />}>
      {(w) => {
        if (!w) return null;
        const open = w.eligible && w.spinsLeftToday > 0;
        const next = formatInstant(w.nextSpinAt, lang);
        const reason = refusalKeyOf(w.refusalReason);
        return (
          <div className="flex h-full flex-col items-start gap-2">
            <p className={`text-base font-bold ${open ? "text-primary" : "text-text-primary"}`}>{t("common", open ? D.wheel.open : D.wheel.closed)}</p>
            {!open && reason && <p className="text-xs text-text-secondary">{t("common", reason)}</p>}
            {!open && next && <p className="text-xs text-text-secondary">{t("common", K.nextSpinAt, { time: next })}</p>}
            <Link
              href={PANEL_WHEEL}
              className={
                open
                  ? "mt-auto inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-bold text-on-accent hover:brightness-105"
                  : "mt-auto text-sm font-bold text-primary hover:underline"
              }
            >
              <Gift size={14} aria-hidden />
              {t("common", open ? K.spin : K.title)}
            </Link>
          </div>
        );
      }}
    </WidgetBody>
  );
}
