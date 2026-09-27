"use client";

import { AlertTriangle, CalendarClock, Gauge, Infinity as Unlimited } from "lucide-react";
import type { ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { GrantRow } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { useTimeLeft } from "../_hooks/useTimeLeft";
import { levelOf, percentLeft, type Level } from "../_lib/pulse";
import { formatBytes } from "../_lib/service-configs";
import { remainingBytes, usedShare } from "../_lib/usage";

const S = FrontendI18nKeys.common.myServices;
const M = S.meter;

const FILL: Record<Level, string> = { ok: "bg-primary", low: "bg-gold", critical: "bg-error" };
const FIGURE: Record<Level, string> = { ok: "text-text-primary", low: "text-gold", critical: "text-error" };

/**
 * A service's traffic and time, side by side, each leading with **what is
 * left** (F-307-u; user, 2026-09-27: the old bar of what was used read both
 * ways). The bar is the tank, and it drains: full when bought, empty when
 * spent, green, then gold under a quarter, red under a tenth. Under it, the
 * plain sentence of used-of-bought, so no figure has to be decoded.
 *
 * The bound is the row's (contract.my-services.md rule 15): what a metered
 * Grant bought, a capped prepaid one's cap, none for unlimited traffic — which
 * says so — or for a prepaid one billing answered no cap for, which shows what
 * it used. Time counts down in the browser (`useTimeLeft`, F-307-s). Nothing
 * here reads anything.
 *
 * `live` runs the traffic bar's current, so a service in use looks it.
 * `warn` asks for the running-out lines — only a live-state Grant gets them;
 * a suspended one already says what to do.
 */
export function UsageMeter({ row, live, warn }: { row: GrantRow; live: boolean; warn: boolean }) {
  const { t, lang } = useLocale();

  const consumed = formatBytes(row.consumedBytes, lang) ?? row.consumedBytes;
  const bound = row.trafficUnlimited
    ? null
    : row.billingMode === "metered"
      ? row.purchasedBytes
      : row.trafficCapBytes;
  const share = bound !== null ? usedShare(row.consumedBytes, bound) : null;
  const boundText = bound !== null ? (formatBytes(bound, lang) ?? bound) : "";
  const remaining = bound !== null ? (formatBytes(remainingBytes(row.consumedBytes, bound), lang) ?? "") : "";
  const trafficLeft = share === null ? null : 1 - share;
  const trafficLevel = trafficLeft === null ? "ok" : levelOf(trafficLeft);

  const from = formatInstant(row.startsAt, lang) ?? row.startsAt;
  const until = row.endsAt ? formatInstant(row.endsAt, lang) : null;
  const time = useTimeLeft(row.startsAt, row.endsAt);
  const timeLeftShare = time === null ? null : 1 - time.spent;
  const timeLevel = timeLeftShare === null ? "ok" : levelOf(timeLeftShare);
  const days =
    time === null
      ? null
      : time.spent >= 1
        ? t("common", S.left.ended)
        : time.days > 0
          ? t("common", S.left.dayHours, { days: time.days, hours: time.hours })
          : time.hours > 0
            ? t("common", S.left.hourMinutes, { hours: time.hours, minutes: time.minutes })
            : t("common", S.left.minutes, { minutes: time.minutes });

  const lowTraffic = warn && trafficLeft !== null && trafficLevel === "critical";
  const lowTime = warn && time !== null && time.spent < 1 && time.days === 0;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {/* Traffic */}
        {trafficLeft !== null && share !== null ? (
          <Tile icon={<Gauge size={14} aria-hidden />} label={t("common", M.traffic)}>
            <p className="flex flex-wrap items-baseline gap-x-1.5">
              <span className={`text-xl font-black tabular-nums leading-tight ${FIGURE[trafficLevel]}`} dir="ltr">
                {remaining}
              </span>
              <span className="text-xs text-text-secondary">{t("common", M.of, { total: boundText })}</span>
            </p>
            <Bar
              left={trafficLeft}
              level={trafficLevel}
              flowing={live}
              label={t("common", S.ring.label, { used: consumed, bought: boundText, remaining })}
            />
            <p className="flex flex-wrap items-center justify-between gap-x-2 text-[11px] text-text-secondary">
              <span>{t("common", S.usage, { consumed, purchased: boundText })}</span>
              <span className={`font-bold ${FIGURE[trafficLevel]}`}>
                {t("common", M.percentLeft, { percent: percentLeft(trafficLeft) })}
              </span>
            </p>
          </Tile>
        ) : row.trafficUnlimited ? (
          <Tile icon={<Gauge size={14} aria-hidden />} label={t("common", M.traffic)}>
            <p className="flex items-center gap-1.5 text-xl font-black leading-tight text-primary">
              <Unlimited size={22} aria-hidden />
              {t("common", M.unlimited)}
            </p>
            <Bar left={1} level="ok" flowing={live} />
            <p className="text-[11px] text-text-secondary">{t("common", S.usageUnlimited, { consumed })}</p>
          </Tile>
        ) : (
          <Tile icon={<Gauge size={14} aria-hidden />} label={t("common", M.trafficUsed)}>
            <p className="text-xl font-black tabular-nums leading-tight text-text-primary" dir="ltr">
              {consumed}
            </p>
            <Bar left={1} level="ok" flowing={live} />
          </Tile>
        )}

        {/* Time */}
        <Tile icon={<CalendarClock size={14} aria-hidden />} label={t("common", M.time)}>
          {time === null || timeLeftShare === null ? (
            <>
              <p className="flex items-center gap-1.5 text-xl font-black leading-tight text-primary">
                <Unlimited size={22} aria-hidden />
                {t("common", M.unlimited)}
              </p>
              <Bar left={1} level="ok" />
              <p className="text-[11px] text-text-secondary">{t("common", S.periodUnlimited, { from })}</p>
            </>
          ) : (
            <>
              <p className={`text-base font-black leading-tight ${FIGURE[timeLevel]}`} title={until ?? undefined}>
                {days}
              </p>
              <Bar left={timeLeftShare} level={timeLevel} />
              {until && <p className="text-[11px] text-text-secondary">{t("common", M.until, { at: until })}</p>}
            </>
          )}
        </Tile>
      </div>

      {(lowTraffic || lowTime) && (
        <p role="status" className="flex items-start gap-2 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            {lowTraffic && t("common", M.lowTraffic)}
            {lowTraffic && lowTime && " "}
            {lowTime && t("common", M.lowTime)}
          </span>
        </p>
      )}
    </div>
  );
}

function Tile({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-2xl bg-bg-inner p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-bold text-text-secondary">
        {icon}
        {label}
      </p>
      {children}
    </div>
  );
}

/**
 * A tank that drains: the fill is what is left. `flowing` runs a current
 * through it — the service is moving data now. A sliver stays visible while
 * anything is left, so "almost empty" never reads as "empty".
 */
function Bar({ left, level, flowing = false, label }: { left: number; level: Level; flowing?: boolean; label?: string }) {
  const width = left <= 0 ? 0 : Math.max(left, 0.03) * 100;
  return (
    <div
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="h-2.5 w-full overflow-hidden rounded-full bg-card-border/60"
    >
      <div
        className={`relative h-full overflow-hidden rounded-full transition-[width] duration-700 ease-out ${FILL[level]}`}
        style={{ width: `${width}%` }}
      >
        {flowing && <span className="meter-flow absolute inset-0" aria-hidden />}
      </div>
    </div>
  );
}
