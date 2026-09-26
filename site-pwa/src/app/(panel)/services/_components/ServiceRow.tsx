"use client";

import { useState } from "react";
import { AlertCircle, ChevronDown, Copy, Loader2, QrCode, RotateCcw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { copyText } from "../../_lib/clipboard";
import { formatInstant } from "../../_lib/datetime";
import { GRANT_TONES, type CapabilityName } from "../_lib/my-services";
import { formatBytes, purgeCountdown } from "../_lib/service-configs";
import { GrantConfigs } from "./GrantConfigs";
import { UsageRing } from "./UsageRing";

const S = FrontendI18nKeys.common.myServices;
const L = S.link;

/**
 * One Grant on the "my services" page (F-502-s): what it is, how long it runs,
 * what state billing says it is in — and its subscription link (F-114-e-c).
 *
 * **The link is asked for, never carried.** The list answers no token
 * (`billing/contract.gift.md`); the link is read from its own route the first
 * time this row needs it — a copy or the QR — and held only while the page is
 * up. Billing keeps the token sealed and answers the same link every time
 * (ADR-0085), so there is nothing to lose by not storing it.
 *
 * **Reset is for a leaked link, behind a question.** It destroys the link the
 * user's app already holds, so it asks first, never retries, and a refusal
 * changes nothing on screen. Every control is offered whatever the status:
 * a link opens nothing more than its Grant allows, because `/sub` reads it.
 *
 * **Configs first, the link folded below** (F-307-c, user 2026-09-26). The
 * row leads with used-against-bought and, expanded, the 30 days and each
 * config's own lines; the `/sub` link — the one that keeps an app up to date
 * after a new key — stays, closed until asked for.
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
  const toMessage = useApiErrorMessage();

  // The link billing answered for this row, or `null` until something asks.
  const [link, setLink] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [showLink, setShowLink] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [error, setError] = useState<{ message: string; ref?: string } | null>(null);

  const tone = GRANT_TONES[row.status];
  const from = formatInstant(row.startsAt, lang);
  const until = row.endsAt ? formatInstant(row.endsAt, lang) : null;
  const period = until
    ? t("common", S.period, { from: from ?? row.startsAt, until })
    : t("common", S.periodUnlimited, { from: from ?? row.startsAt });

  // Consumed is measured against a bound: a metered Grant's is what it has
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
  const usage = row.trafficUnlimited
    ? t("common", S.usageUnlimited, { consumed })
    : bound !== null
      ? t("common", S.usage, { consumed, purchased: formatBytes(bound, lang) ?? bound })
      : t("common", S.usageUnmetered, { consumed });
  const countdown = purgeCountdown(row.purgeAt);

  function refused(e: unknown) {
    // Billing's own sentence, laid out (`contract.errors.md`) — `link_not_kept`
    // tells an older Grant's user to reset once.
    console.error(e);
    setError({ message: toMessage(e), ref: e instanceof ApiError ? e.ref : undefined });
  }

  /** The link, read once per row; `null` after a refusal, which is on screen. */
  async function readLink(): Promise<string | null> {
    if (link) return link;
    setError(null);
    setIsReading(true);
    try {
      const { subscriptionUrl } = await billingApi.subscriptionLink(row.id);
      setLink(subscriptionUrl);
      return subscriptionUrl;
    } catch (e) {
      refused(e);
      return null;
    } finally {
      setIsReading(false);
    }
  }

  async function copy() {
    if (isReading) return;
    const url = await readLink();
    if (!url) return;
    if (await copyText(url)) setCopied(true);
    // No clipboard (an insecure origin, an old in-app browser): the link is
    // shown to select by hand.
    else setShowLink(true);
  }

  async function toggleQr() {
    if (qrOpen) return setQrOpen(false);
    if (await readLink()) setQrOpen(true);
  }

  async function reset() {
    if (isResetting) return;
    setConfirmReset(false);
    setError(null);
    setIsResetting(true);
    try {
      const { subscriptionUrl } = await billingApi.resetSubscriptionLink(row.id);
      // The old link is dead inside billing's transaction, so it must not stay
      // on screen to be copied.
      setLink(subscriptionUrl);
      setResetDone(true);
      setCopied(false);
    } catch (e) {
      // Nothing was reset, so whatever is on screen is still the link.
      refused(e);
    } finally {
      setIsResetting(false);
    }
  }

  return (
    <li className="rounded-2xl border border-card-border bg-card-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {bound !== null && <UsageRing consumedBytes={row.consumedBytes} purchasedBytes={bound} />}
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-text-primary">{name ?? t("common", S.unnamed)}</p>
            <p className="mt-1 text-xs text-text-secondary">{period}</p>
            <p className="mt-1 text-xs text-text-secondary">{usage}</p>
          </div>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone.className}`}
        >
          <tone.icon size={10} aria-hidden />
          {t("common", tone.labelKey)}
        </span>
      </div>

      {/* Paid and not yet delivered (F-111-f). The page re-reads on its own
          when delivery ends, so the sentence says there is nothing to do. */}
      {row.status === "pending" && (
        <p
          role="status"
          className="mt-3 rounded-2xl border border-gold/20 bg-gold-bg px-3 py-2 text-xs font-medium text-gold"
        >
          {t("common", S.preparing)}
        </p>
      )}

      {countdown !== null && (
        <p
          role="status"
          className="mt-3 rounded-2xl border border-gold/20 bg-gold-bg px-3 py-2 text-xs font-medium text-gold"
        >
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
              <li
                key={key}
                title={key}
                className="rounded-lg border border-card-border bg-bg-inner px-2 py-0.5 text-[10px] text-text-secondary"
              >
                {label}
              </li>
            ) : (
              // No published name in this language: the key, which support can read.
              <li
                key={key}
                dir="ltr"
                className="rounded-lg border border-card-border bg-bg-inner px-2 py-0.5 font-mono text-[10px] text-text-secondary"
              >
                {key}
              </li>
            ),
          )}
        </ul>
      )}

      <GrantConfigs grantId={row.id} asked={configsAsked} />

      <button
        type="button"
        aria-expanded={linkOpen}
        onClick={() => setLinkOpen((o) => !o)}
        className="mt-3 flex w-full items-center justify-between rounded-2xl border border-card-border px-3 py-2 text-xs font-bold text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
      >
        {t("common", L.label)}
        <ChevronDown size={14} className={linkOpen ? "rotate-180" : ""} aria-hidden />
      </button>

      {linkOpen && (
        <>
          <div className="mt-3 rounded-2xl border border-card-border bg-bg-inner p-3">
            <p className="text-[11px] text-text-secondary">{t("common", L.hint)}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void copy()}
                disabled={isReading}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
              >
                {isReading ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden />
                ) : (
                  <Copy size={14} aria-hidden />
                )}
                {t("common", isReading ? L.copying : copied ? L.copied : L.copy)}
              </button>
              <button
                type="button"
                onClick={() => void toggleQr()}
                disabled={isReading}
                className="flex items-center gap-1.5 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-secondary hover:bg-leaf-bg hover:text-text-primary disabled:opacity-50"
              >
                <QrCode size={14} aria-hidden />
                {t("common", qrOpen ? L.hideQr : L.showQr)}
              </button>
            </div>

            {link && (qrOpen || showLink) && (
              <div className="mt-3 space-y-3">
                {qrOpen && (
                  // White behind the code in both themes: a scanner needs the contrast.
                  <div role="img" aria-label={t("common", L.qrLabel)} className="mx-auto w-fit rounded-xl bg-white p-3">
                    <QRCodeSVG value={link} size={176} aria-hidden />
                  </div>
                )}
                <code className="block select-all break-all font-mono text-xs text-text-primary" dir="ltr">
                  {link}
                </code>
              </div>
            )}

            {resetDone && <p className="mt-2 text-[11px] font-bold text-text-secondary">{t("common", L.resetDone)}</p>}
          </div>

          {error && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-3 rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm font-medium text-error"
            >
              <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
              <span className="min-w-0">
                {error.message}
                {error.ref && (
                  <span className="mt-1 block font-mono text-[0.65rem] opacity-70" dir="ltr">
                    {error.ref}
                  </span>
                )}
              </span>
            </div>
          )}

          {confirmReset ? (
            <div className="mt-3 rounded-2xl border border-error-border bg-error-bg p-3">
              <p className="text-[13px] font-bold text-error">{t("common", L.resetConfirm)}</p>
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
                  onClick={() => void reset()}
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
              disabled={isResetting}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border py-3 text-xs font-bold text-text-secondary transition-colors duration-200 hover:bg-leaf-bg hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isResetting ? (
                <Loader2 size={14} className="animate-spin" aria-hidden />
              ) : (
                <RotateCcw size={14} aria-hidden />
              )}
              {t("common", isResetting ? L.resetting : L.reset)}
            </button>
          )}
        </>
      )}
    </li>
  );
}
