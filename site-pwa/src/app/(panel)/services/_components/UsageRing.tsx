"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { formatBytes } from "../_lib/service-configs";
import { remainingBytes, usedShare } from "../_lib/usage";

const R = FrontendI18nKeys.common.myServices.ring;

const RADIUS = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Used against bought, as a ring (F-307-c) — drawn from the Grant's own bytes,
 * so it costs no read. The bound is a metered Grant's bought bytes or a capped
 * prepaid one's cap (F-111-t); an unlimited Grant, or a metered one before its
 * first block, has nothing to be a share of and draws no ring. SVG, no chart library; the colours are theme tokens.
 */
export function UsageRing({ consumedBytes, purchasedBytes }: { consumedBytes: string; purchasedBytes: string }) {
  const { t, lang } = useLocale();
  const used = usedShare(consumedBytes, purchasedBytes);
  if (used === null) return null;

  const label = t("common", R.label, {
    used: formatBytes(consumedBytes, lang) ?? consumedBytes,
    bought: formatBytes(purchasedBytes, lang) ?? purchasedBytes,
    remaining: formatBytes(remainingBytes(consumedBytes, purchasedBytes), lang) ?? "",
  });
  // A sliver of use still shows: a ring that reads empty at 0.3% looks unmetered.
  const drawn = used === 0 ? 0 : Math.max(used, 0.02);
  const full = used >= 1;

  return (
    <div role="img" aria-label={label} title={label} className="relative h-14 w-14 shrink-0">
      <svg viewBox="0 0 40 40" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="20" cy="20" r={RADIUS} fill="none" strokeWidth="5" className="stroke-card-border" />
        <circle
          cx="20"
          cy="20"
          r={RADIUS}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${drawn * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          className={full ? "stroke-error" : "stroke-primary"}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center text-[10px] font-black text-text-primary"
        dir="ltr"
      >
        {Math.floor(used * 100)}%
      </span>
    </div>
  );
}
