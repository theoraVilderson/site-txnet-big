"use client";

import { AlertTriangle, CalendarClock, Gauge, Infinity as Unlimited, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { GrantRow } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import type { PeriodRead } from "../_hooks/useGrantPeriod";
import { useTimeLeft } from "../_hooks/useTimeLeft";
import { levelOf, percentLeft, type Level } from "../_lib/pulse";
import { formatBytes } from "../_lib/service-configs";
import { livePeriodBytes, remainingBytes, usedShare } from "../_lib/usage";

const S = FrontendI18nKeys.common.myServices;
const M = S.meter;

/** The tank's colour, a theme token per level (gold is a tone, never a control). */
const TANK: Record<Level, string> = { ok: "var(--color-primary)", low: "var(--color-gold)", critical: "var(--color-error)" };
const FIGURE: Record<Level, string> = { ok: "text-text-primary", low: "text-gold", critical: "text-error" };
const PILL: Record<Level, string> = {
  ok: "bg-leaf-bg text-primary",
  low: "bg-gold-bg text-gold",
  critical: "bg-error-bg text-error",
};
/** A tile nearly out is tinted, so the eye finds it before reading it. */
const TILE: Record<Level, string> = {
  ok: "border-transparent bg-bg-inner",
  low: "border-transparent bg-bg-inner",
  critical: "border-error-border bg-error-bg",
};

/**
 * A service's traffic and time, side by side, each leading with **what is
 * left** (F-307-u; user, 2026-09-27: the old bar of what was used read both
 * ways). The bar is the tank, and it fills with what is used, climbing toward
 * the bound (user, 2026-09-27: a bar that shrinks reads backwards): empty when
 * bought, full when spent, green, then gold under a quarter left, red under a
 * tenth. Under it, the
 * plain sentence of used-of-bought, so no figure has to be decoded.
 *
 * The bound is the row's (contract.my-services.md rule 15): a capped prepaid
 * one's cap, none for unlimited traffic — which says so — or for a prepaid one
 * billing answered no cap for, which shows what it used. A metered Grant has
 * no bound at all (F-118-aj, contract.service-pulse.md rule 7): what billing
 * bought for it is a bag, not a limit, so its tile is `PaygTraffic` — this
 * billing period's bytes, from `period` when the row has read it. Time counts
 * down in the browser (`useTimeLeft`, F-307-s). Nothing here reads anything.
 *
 * The bar is a tank (`Tank`, `globals.css` "My services"): it fills up when
 * the page opens and a glowing head rides its edge. `live` (in use) runs a
 * glint through the traffic tank, beats its head and lets a red tank breathe —
 * a service not in use, or spent, stays still; no stripes (user, 2026-09-27); `splash` (the
 * latest push's number) sends a ring out of the head as the bytes land.
 * `warn` asks for the running-out lines — only a live-state Grant gets them;
 * a suspended one already says what to do.
 */
export function UsageMeter({
  row,
  live,
  warn,
  splash,
  period = null,
}: {
  row: GrantRow;
  live: boolean;
  warn: boolean;
  splash?: number;
  /** A metered Grant's billing period, as its row read it; none is the lifetime total. */
  period?: PeriodRead | null;
}) {
  const { t, lang } = useLocale();

  const consumed = formatBytes(row.consumedBytes, lang) ?? row.consumedBytes;
  const payg = row.billingMode === "metered" && !row.trafficUnlimited;
  const bound = row.trafficUnlimited || payg ? null : row.trafficCapBytes;
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
        {payg ? (
          <PaygTraffic row={row} period={period} live={live} splash={splash} />
        ) : trafficLeft !== null && share !== null ? (
          <Tile icon={<Gauge size={14} aria-hidden />} label={t("common", M.traffic)} level={trafficLevel}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
              <p className="meter-figure flex flex-wrap items-baseline gap-x-1.5">
                <span className={`text-xl font-black tabular-nums leading-tight ${FIGURE[trafficLevel]}`} dir="ltr">
                  {remaining}
                </span>
                <span className="text-xs text-text-secondary">{t("common", M.of, { total: boundText })}</span>
              </p>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${PILL[trafficLevel]}`}>
                {t("common", M.percentLeft, { percent: percentLeft(trafficLeft) })}
              </span>
            </div>
            <Tank
              used={share}
              level={trafficLevel}
              live={live}
              splash={splash}
              label={t("common", S.ring.label, { used: consumed, bought: boundText, remaining })}
            />
            <p className="text-[11px] text-text-secondary">{t("common", S.usage, { consumed, purchased: boundText })}</p>
          </Tile>
        ) : row.trafficUnlimited ? (
          <Tile icon={<Gauge size={14} aria-hidden />} label={t("common", M.traffic)}>
            <p className="meter-figure flex items-center gap-1.5 text-xl font-black leading-tight text-primary">
              <Unlimited size={22} aria-hidden />
              {t("common", M.unlimited)}
            </p>
            <Tank used={1} level="ok" live={live} splash={splash} />
            <p className="text-[11px] text-text-secondary">{t("common", S.usageUnlimited, { consumed })}</p>
          </Tile>
        ) : (
          <Tile icon={<Gauge size={14} aria-hidden />} label={t("common", M.trafficUsed)}>
            <p className="meter-figure text-xl font-black tabular-nums leading-tight text-text-primary" dir="ltr">
              {consumed}
            </p>
            <Tank used={1} level="ok" live={live} splash={splash} />
          </Tile>
        )}

        {/* Time */}
        <Tile icon={<CalendarClock size={14} aria-hidden />} label={t("common", M.time)} level={timeLevel}>
          {time === null || timeLeftShare === null ? (
            <>
              <p className="meter-figure flex items-center gap-1.5 text-xl font-black leading-tight text-primary">
                <Unlimited size={22} aria-hidden />
                {t("common", M.unlimited)}
              </p>
              <Tank used={1} level="ok" />
              <p className="text-[11px] text-text-secondary">{t("common", S.periodUnlimited, { from })}</p>
            </>
          ) : (
            <>
              <p className={`meter-figure text-base font-black leading-tight ${FIGURE[timeLevel]}`} title={until ?? undefined}>
                {days}
              </p>
              <Tank used={time.spent} level={timeLevel} />
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

/**
 * A pay-as-you-go service's traffic (F-118-aj; user, 2026-09-30): no cap, so
 * no "left" and no bar toward one. It leads with this billing period's bytes
 * — pushes added live (`livePeriodBytes`) — then the period's cost and dates,
 * the last period, what the balance still covers, and the lifetime total
 * small. Without a period (a failed read, an admin's view) it says "no cap"
 * and what was used in all, which is still true.
 */
function PaygTraffic({ row, period, live, splash }: { row: GrantRow; period: PeriodRead | null; live: boolean; splash?: number }) {
  const { t, lang } = useLocale();
  const bytes = (v: string) => formatBytes(v, lang) ?? v;
  const lifetime = bytes(row.consumedBytes);
  const view = period?.view ?? null;
  const money = (v: string) => (view?.currencyCode ? formatMoney(v, view.currencyCode, { lang, t }) : null);
  const day = (v: string) => formatInstant(v, lang, { withTime: false }) ?? v;

  return (
    <Tile icon={<Gauge size={14} aria-hidden />} label={t("common", view ? M.thisPeriod : M.trafficUsed)}>
      <p className="meter-figure text-xl font-black tabular-nums leading-tight text-text-primary" dir="ltr">
        {view && period ? bytes(livePeriodBytes(view.current.consumedBytes, period.baseline, row.consumedBytes)) : lifetime}
      </p>
      <p className="flex items-center gap-1 text-[11px] font-bold text-primary">
        <Unlimited size={14} aria-hidden />
        {t("common", M.payg)}
      </p>
      <Tank used={1} level="ok" live={live} splash={splash} />
      {view && (
        <div className="space-y-0.5 text-[11px] text-text-secondary">
          {money(view.current.spent) && <p className="font-bold text-text-primary">{t("common", M.periodCost, { amount: money(view.current.spent)! })}</p>}
          <p>{t("common", M.periodRange, { from: day(view.current.from), to: day(view.current.to) })}</p>
          {view.previous && (
            <p>
              {money(view.previous.spent)
                ? t("common", M.previousPeriod, { bytes: bytes(view.previous.consumedBytes), amount: money(view.previous.spent)! })
                : t("common", M.previousPeriodBytes, { bytes: bytes(view.previous.consumedBytes) })}
            </p>
          )}
          {view.coversBytes !== null && (
            <p className="flex items-center gap-1">
              <Wallet size={12} aria-hidden />
              {BigInt(view.coversBytes) > BigInt(0) ? t("common", M.covers, { bytes: bytes(view.coversBytes) }) : t("common", M.coversNothing)}
            </p>
          )}
          <p>{t("common", M.lifetime, { bytes: lifetime })}</p>
        </div>
      )}
    </Tile>
  );
}

function Tile({ icon, label, level = "ok", children }: { icon: ReactNode; label: string; level?: Level; children: ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-2 rounded-2xl border p-3 transition-colors duration-500 ${TILE[level]}`}>
      <p className="flex items-center gap-1.5 text-[11px] font-bold text-text-secondary">
        {icon}
        {label}
      </p>
      {children}
    </div>
  );
}

/**
 * A tank that fills toward its bound: the fill is what is used, in `--tank`,
 * with a head of light on its leading edge. A sliver shows once anything is
 * used, so "barely touched" never reads as "untouched"; an unused tank has no
 * head. Unlimited has no bound to near, so its tank stays full and green. Ticks at
 * the quarters give the eye a scale without a single number.
 */
function Tank({
  used,
  level,
  live = false,
  splash,
  label,
}: {
  used: number;
  level: Level;
  live?: boolean;
  splash?: number;
  label?: string;
}) {
  const width = used <= 0 ? 0 : Math.min(Math.max(used, 0.04), 1) * 100;
  const head = `max(0px, calc(${width}% - 0.6rem))`;
  return (
    <div
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-level={level}
      className={`tank ${live ? "tank-live" : ""}`}
      style={{ ["--tank" as string]: TANK[level] }}
    >
      {[25, 50, 75].map((at) => (
        <span key={at} className="tank-tick" style={{ insetInlineStart: `${at}%` }} aria-hidden />
      ))}
      {width > 0 && (
        <>
          <div className={`tank-fill ${live && level === "critical" ? "tank-critical" : ""}`} style={{ width: `${width}%` }}>
            {live && <span className="tank-glint" aria-hidden />}
          </div>
          <span className="tank-head" style={{ insetInlineStart: head }} aria-hidden />
          {live && splash !== undefined && (
            <span key={splash} className="tank-ripple" style={{ insetInlineStart: head }} aria-hidden />
          )}
        </>
      )}
    </div>
  );
}
