"use client";

import { useState } from "react";
import { ChevronDown, Loader2, Plug, RotateCcw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { GrantRow } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { useGrantConfigs } from "../_hooks/useGrantConfigs";
import { useSubscriptionLink } from "../_hooks/useSubscriptionLink";
import { GRANT_TONES, type CapabilityName } from "../_lib/my-services";
import { formatBytes, purgeCountdown } from "../_lib/service-configs";
import { remainingBytes, timeLeft, usedShare } from "../_lib/usage";
import { ConnectPanel, LinkError } from "./ConnectPanel";
import { GrantConfigs } from "./GrantConfigs";
import { Meter } from "./Meter";
import { UsageBars } from "./UsageBars";

const S = FrontendI18nKeys.common.myServices;
const L = S.link;

type Panel = "connect" | "manage" | null;

/**
 * One Grant on the "my services" page (F-502-s), laid out for the question a
 * user arrives with (user, 2026-09-26: "nothing is easy, the words are not
 * clear"):
 *
 * 1. **What is it and is it working** — its name and a status pill big
 *    enough to read.
 * 2. **How much is left** — traffic and time, each a headline and a bar,
 *    from the row itself (no read).
 * 3. **Connect** — the one strong button. It opens each server's lines and
 *    the subscription link (`ConnectPanel`); nothing there changes anything.
 * 4. **Details** — the 30 days, each server's share, a new link, delete, and
 *    resetting the subscription link. Everything that can break a working
 *    setup is here, one press further away.
 *
 * Only one of the two is open at a time: on a phone, two long panels under
 * one card lose the card. Both share the row's configs and link, so moving
 * between them reads nothing twice, and a reset in "details" replaces the
 * link "connect" shows.
 */
export function ServiceRow({
  row,
  name,
  capabilities,
  configsAsked = 0,
}: {
  row: GrantRow;
  name: string | null;
  /** `capabilityNames` of this row — a name where one is published, else the key (F-114-f-c). */
  capabilities: CapabilityName[];
  /** `useGrantsPage().configsAsked` for this row: its open config list re-reads when it moves (F-111-l). */
  configsAsked?: number;
}) {
  const { t, lang } = useLocale();
  const [panel, setPanel] = useState<Panel>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const configs = useGrantConfigs(row.id, panel !== null, configsAsked);
  const sub = useSubscriptionLink(row.id);

  const tone = GRANT_TONES[row.status];
  const countdown = purgeCountdown(row.purgeAt);
  const toggle = (next: Exclude<Panel, null>) => setPanel((p) => (p === next ? null : next));

  // Traffic is measured against a bound: a metered Grant's is what it has
  // bought (ADR-0072), a capped prepaid one's the cap billing answers — the
  // `total` `/sub` gives the app, rollover included (F-111-t). A Grant sold
  // with unlimited traffic says so: its 0 bought bounds nothing (F-111-s,
  // entitlement invariant 15). No bound at all shows what was used alone.
  const consumed = formatBytes(row.consumedBytes, lang) ?? row.consumedBytes;
  const bound = row.trafficUnlimited
    ? null
    : row.billingMode === "metered"
      ? row.purchasedBytes
      : row.trafficCapBytes;
  const share = bound !== null ? usedShare(row.consumedBytes, bound) : null;
  const boundText = bound !== null ? (formatBytes(bound, lang) ?? bound) : null;
  const traffic =
    row.trafficUnlimited
      ? { headline: t("common", S.left.unlimited), detail: t("common", S.usageUnlimited, { consumed }) }
      : bound !== null && share !== null
        ? {
            headline: t("common", S.left.traffic, {
              left: formatBytes(remainingBytes(row.consumedBytes, bound), lang) ?? "",
            }),
            detail: t("common", S.usage, { consumed, purchased: boundText ?? "" }),
          }
        : { headline: consumed, detail: t("common", S.usageUnmetered, { consumed }) };

  const from = formatInstant(row.startsAt, lang) ?? row.startsAt;
  const until = row.endsAt ? formatInstant(row.endsAt, lang) : null;
  const time = timeLeft(row.startsAt, row.endsAt);
  const period = until
    ? t("common", S.period, { from, until })
    : t("common", S.periodUnlimited, { from });

  return (
    <li className="rounded-3xl border border-card-border bg-card-bg p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-base font-bold text-text-primary md:text-lg">{name ?? t("common", S.unnamed)}</h2>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold ${tone.className}`}
        >
          <tone.icon size={14} aria-hidden />
          {t("common", tone.labelKey)}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Meter
          title={t("common", S.left.trafficTitle)}
          headline={traffic.headline}
          detail={traffic.detail}
          share={share}
          label={
            bound !== null && share !== null
              ? t("common", S.ring.label, {
                  used: consumed,
                  bought: boundText ?? "",
                  remaining: formatBytes(remainingBytes(row.consumedBytes, bound), lang) ?? "",
                })
              : undefined
          }
        />
        <Meter
          title={t("common", S.left.timeTitle)}
          headline={
            time === null
              ? t("common", S.left.unlimited)
              : time.days === 0
                ? t("common", S.left.ended)
                : t("common", S.left.days, { days: time.days })
          }
          detail={period}
          share={time?.spent ?? null}
          label={time && until ? t("common", S.left.timeLabel, { days: time.days, until }) : undefined}
        />
      </div>

      {/* Paid and not yet delivered (F-111-f). The page re-reads on its own
          when delivery ends, so the sentence says there is nothing to do. */}
      {row.status === "pending" && (
        <p role="status" className="mt-3 rounded-2xl border border-gold/20 bg-gold-bg px-3 py-2 text-sm font-medium text-gold">
          {t("common", S.preparing)}
        </p>
      )}

      {countdown !== null && (
        <p role="status" className="mt-3 rounded-2xl border border-gold/20 bg-gold-bg px-3 py-2 text-sm font-medium text-gold">
          {countdown === "due"
            ? t("common", S.purgeDue)
            : t("common", S.purgeIn, {
                days: countdown.days,
                hours: countdown.hours,
                at: formatInstant(row.purgeAt, lang) ?? row.purgeAt ?? "",
              })}
        </p>
      )}

      {capabilities.length > 0 && (
        <ul aria-label={t("common", S.features)} className="mt-3 flex flex-wrap gap-1.5">
          {capabilities.map(({ key, name: label }) =>
            label ? (
              <li key={key} title={key} className="rounded-lg bg-bg-inner px-2.5 py-1 text-xs text-text-secondary">
                {label}
              </li>
            ) : (
              // No published name in this language: the key, which support can read.
              <li key={key} dir="ltr" className="rounded-lg bg-bg-inner px-2.5 py-1 font-mono text-xs text-text-secondary">
                {key}
              </li>
            ),
          )}
        </ul>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          aria-expanded={panel === "connect"}
          onClick={() => toggle("connect")}
          className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm font-bold text-white"
        >
          <Plug size={16} aria-hidden />
          {t("common", S.connect.open)}
        </button>
        <button
          type="button"
          aria-expanded={panel === "manage"}
          onClick={() => toggle("manage")}
          className="flex items-center justify-center gap-2 rounded-2xl border border-card-border px-4 py-3 text-sm font-bold text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
        >
          {t("common", S.manage.open)}
          <ChevronDown size={16} className={panel === "manage" ? "rotate-180" : ""} aria-hidden />
        </button>
      </div>

      {panel === "connect" && <ConnectPanel configs={configs} sub={sub} />}

      {panel === "manage" && (
        <div className="mt-4 space-y-4">
          <UsageBars grantId={row.id} />
          <GrantConfigs configs={configs} />

          <section aria-label={t("common", L.resetTitle)} className="rounded-2xl border border-card-border bg-bg-inner p-4">
            <p className="text-sm font-bold text-text-primary">{t("common", L.resetTitle)}</p>
            <p className="mt-1 text-xs leading-6 text-text-secondary">{t("common", L.resetHint)}</p>

            {confirmReset ? (
              <div className="mt-3 rounded-2xl border border-error-border bg-error-bg p-3">
                <p className="text-sm font-bold text-error">{t("common", L.resetConfirm)}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    autoFocus
                    className="flex-1 rounded-xl bg-primary py-2.5 text-xs font-bold text-white"
                  >
                    {t("common", L.resetNo)}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmReset(false);
                      void sub.reset();
                    }}
                    className="flex-1 rounded-xl bg-leaf-bg py-2.5 text-xs font-bold text-text-primary"
                  >
                    {t("common", L.resetYes)}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                disabled={sub.isResetting}
                className="mt-3 flex items-center gap-2 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sub.isResetting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RotateCcw size={14} aria-hidden />}
                {t("common", sub.isResetting ? L.resetting : L.reset)}
              </button>
            )}

            {sub.resetDone && sub.link && (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-bold text-primary">{t("common", L.resetDone)}</p>
                <code className="block select-all break-all font-mono text-xs text-text-primary" dir="ltr">
                  {sub.link}
                </code>
              </div>
            )}

            {sub.error && <LinkError error={sub.error} />}
          </section>
        </div>
      )}
    </li>
  );
}
