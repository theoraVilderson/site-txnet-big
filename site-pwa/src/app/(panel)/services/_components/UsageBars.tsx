"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { billingApi, type GrantUsage } from "@/lib/billing-api";
import { formatBytes } from "../_lib/service-configs";
import { dayBars, windowTotal } from "../_lib/usage";

const G = FrontendI18nKeys.common.myServices.chart;

const BAR = 8;
const GAP = 2;
const HEIGHT = 64;

/**
 * A Grant's last 30 days, one bar per UTC day (F-307-c over F-307-b):
 * download below, upload stacked on it, scaled to the busiest day. SVG, no
 * chart library. Mounted only while the service is expanded, so it is read on
 * every expand — its own bucket, beside the config list's. A failure costs the
 * chart only: the configs under it are what the user came for.
 */
export function UsageBars({
  grantId,
  read = billingApi.grantUsage,
}: {
  grantId: string;
  /** Who is asked: the owner's route, or an admin's for the user a path names (F-311-v). Keep it stable — it is a dependency. */
  read?: (grantId: string) => Promise<GrantUsage>;
}) {
  const { t, lang } = useLocale();
  const [usage, setUsage] = useState<GrantUsage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    read(grantId)
      .then((answer) => alive && setUsage(answer))
      .catch((e) => {
        console.error(e);
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [grantId, read]);

  if (failed) return <p className="text-[11px] text-text-secondary">{t("common", G.unavailable)}</p>;
  if (!usage) {
    return (
      <p className="flex items-center gap-2 text-[11px] text-text-secondary">
        <Loader2 size={12} className="animate-spin" aria-hidden />
        {t("common", G.loading)}
      </p>
    );
  }

  const bars = dayBars(usage.days);
  const total = formatBytes(windowTotal(bars), lang) ?? "0 B";
  const width = bars.length * (BAR + GAP) - GAP;

  return (
    <div className="rounded-2xl border border-card-border bg-bg-inner p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10px] font-black uppercase tracking-widest text-text-secondary">{t("common", G.title)}</p>
        <p className="text-[11px] font-bold text-text-primary">{t("common", G.total, { total })}</p>
      </div>
      {/* Oldest on the left in both directions: a time axis does not mirror. */}
      <div dir="ltr">
        <svg
          role="img"
          aria-label={t("common", G.label, { total })}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="h-16 w-full"
        >
          <line x1="0" x2={width} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} className="stroke-card-border" strokeWidth="1" />
          {bars.map((b, i) => {
            const h = b.height * (HEIGHT - 1);
            const down = h * b.downloadShare;
            const x = i * (BAR + GAP);
            return (
              <g key={b.date} data-day={b.date}>
                <title>
                  {t("common", G.day, {
                    date: b.date,
                    download: formatBytes(b.downloadBytes, lang) ?? b.downloadBytes,
                    upload: formatBytes(b.uploadBytes, lang) ?? b.uploadBytes,
                  })}
                </title>
                {/* The whole column, so the day's title answers a hover on an empty day too. */}
                <rect x={x} y={0} width={BAR} height={HEIGHT} fill="transparent" />
                {h > 0 && (
                  <rect
                    x={x}
                    y={HEIGHT - 1 - h}
                    width={BAR}
                    height={h - down}
                    rx="1"
                    className="fill-primary"
                    opacity="0.4"
                  />
                )}
                {down > 0 && (
                  <rect x={x} y={HEIGHT - 1 - down} width={BAR} height={down} rx="1" className="fill-primary" />
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-text-secondary" dir="ltr">
        <span>{usage.from}</span>
        <span>{usage.to}</span>
      </div>
      <div className="mt-1 flex gap-3 text-[10px] text-text-secondary">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-primary" aria-hidden />
          {t("common", G.download)}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-primary opacity-40" aria-hidden />
          {t("common", G.upload)}
        </span>
      </div>
    </div>
  );
}
