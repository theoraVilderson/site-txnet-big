"use client";

import { useState } from "react";
import { AlertCircle, KeyRound, Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type GrantRow } from "@/lib/billing-api";
import { copyText } from "../../_lib/clipboard";
import { formatInstant } from "../../_lib/datetime";
import { GRANT_TONES } from "../_lib/my-services";
import { formatBytes, purgeCountdown } from "../_lib/service-configs";
import { GrantConfigs } from "./GrantConfigs";

const S = FrontendI18nKeys.common.myServices;
/**
 * The key panel's sentences are the gift modal's (C-06 is satisfied by either
 * set). They are deliberately not copied under `myServices`: "shown only this
 * once" and "the previous key has stopped working" are the same two facts
 * about the same credential, and a second copy is a second translation to keep
 * in step — the sentence would drift on one surface and not the other.
 */
const G = FrontendI18nKeys.common.wallet.gift;

/**
 * One Grant on the "my services" page (F-502-s): what it is, how long it runs,
 * what state billing says it is in — and the way back to its subscription key.
 *
 * **The row never shows a key it was given.** The list carries none: billing
 * keeps only the hash (D-35) and selects its columns so that neither the key
 * nor the hash can leave in a list (`billing/contract.gift.md`). A key appears
 * here only as the answer to a press on this row, and what appears is the key
 * billing minted in that call.
 *
 * **The button is offered whatever the status.** An expired or cancelled Grant
 * is the row a user most often came for — the key was lost, not the service —
 * and the route deliberately does not gate on status either (F-502-p).
 */
export function ServiceRow({ row, name }: { row: GrantRow; name: string | null }) {
  const { t, lang } = useLocale();
  const toMessage = useApiErrorMessage();

  // The key billing last minted for this row, or `null` — which is every row
  // until someone asks. A reissue replaces it, because the old one is dead
  // inside billing's transaction and leaving it up would offer a credential
  // that opens nothing.
  const [subscriptionKey, setSubscriptionKey] = useState<string | null>(null);
  const [reissued, setReissued] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [error, setError] = useState<{ message: string; ref?: string } | null>(null);

  const tone = GRANT_TONES[row.status];
  const from = formatInstant(row.startsAt, lang);
  const until = row.endsAt ? formatInstant(row.endsAt, lang) : null;
  const period = until
    ? t("common", S.period, { from: from ?? row.startsAt, until })
    : t("common", S.periodPermanent, { from: from ?? row.startsAt });

  // Consumed is measured, purchased is what was bought (ADR-0072); only a
  // metered Grant buys bytes, so a prepaid one shows what it used alone.
  const consumed = formatBytes(row.consumedBytes, lang) ?? row.consumedBytes;
  const usage =
    row.billingMode === "metered"
      ? t("common", S.usage, { consumed, purchased: formatBytes(row.purchasedBytes, lang) ?? row.purchasedBytes })
      : t("common", S.usageUnmetered, { consumed });
  const countdown = purgeCountdown(row.purgeAt);

  async function askForANewKey() {
    if (isRotating) return;
    setError(null);
    setIsRotating(true);
    try {
      const { subscriptionKey: minted } = await billingApi.rotateGrantToken(row.id);
      // `reissued` is about the *previous* key, so it is set only when there
      // was one on screen to replace; the first ask mints a key for a row that
      // showed none.
      setReissued(subscriptionKey !== null);
      setSubscriptionKey(minted);
      setCopied(false);
    } catch (e) {
      // Nothing was minted, so whatever is on screen is still the key. Only
      // billing's own sentence is added (`contract.errors.md`).
      console.error(e);
      setError({ message: toMessage(e), ref: e instanceof ApiError ? e.ref : undefined });
    } finally {
      setIsRotating(false);
    }
  }

  const copy = async () => {
    if (subscriptionKey && (await copyText(subscriptionKey))) setCopied(true);
  };

  return (
    <li className="rounded-2xl border border-card-border bg-card-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-text-primary">
            {name ?? t("common", S.unnamed)}
          </p>
          <p className="mt-1 text-xs text-text-secondary">{period}</p>
          <p className="mt-1 text-xs text-text-secondary">{usage}</p>
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
        <p role="status" className="mt-3 rounded-2xl border border-gold/20 bg-gold-bg px-3 py-2 text-xs font-medium text-gold">
          {t("common", S.preparing)}
        </p>
      )}

      {countdown !== null && (
        <p role="status" className="mt-3 rounded-2xl border border-gold/20 bg-gold-bg px-3 py-2 text-xs font-medium text-gold">
          {countdown === "due"
            ? t("common", S.purgeDue)
            : t("common", S.purgeIn, {
                days: countdown.days,
                hours: countdown.hours,
                at: formatInstant(row.purgeAt, lang) ?? row.purgeAt ?? "",
              })}
        </p>
      )}

      {row.featureKeys.length > 0 && (
        <ul aria-label={t("common", S.features)} className="mt-3 flex flex-wrap gap-1.5">
          {row.featureKeys.map((key) => (
            <li
              key={key}
              dir="ltr"
              className="rounded-lg border border-card-border bg-bg-inner px-2 py-0.5 font-mono text-[10px] text-text-secondary"
            >
              {key}
            </li>
          ))}
        </ul>
      )}

      {subscriptionKey && (
        <div className="mt-3 rounded-2xl border border-card-border bg-bg-inner p-3">
          <p className="mb-1.5 text-[10px] font-black uppercase tracking-widest text-text-secondary">
            {t("common", G.keyLabel)}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-text-primary" dir="ltr">
              {subscriptionKey}
            </code>
            <button
              type="button"
              onClick={() => void copy()}
              className="shrink-0 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-white"
            >
              {t("common", copied ? G.copied : G.copy)}
            </button>
          </div>
          <p className="mt-2 text-[11px] font-bold text-error">{t("common", G.keyOnce)}</p>
          {reissued && (
            <p className="mt-1 text-[11px] font-bold text-text-secondary">{t("common", G.keyReplaced)}</p>
          )}
        </div>
      )}

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

      <GrantConfigs grantId={row.id} />

      <p className="mt-3 text-[11px] text-text-secondary">{t("common", S.keyHint)}</p>
      <button
        type="button"
        onClick={() => void askForANewKey()}
        disabled={isRotating}
        className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border py-3 text-xs font-bold text-text-secondary transition-colors duration-200 hover:bg-leaf-bg hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isRotating ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <KeyRound size={14} aria-hidden />}
        {t("common", isRotating ? G.newKeySending : G.newKey)}
      </button>
    </li>
  );
}
