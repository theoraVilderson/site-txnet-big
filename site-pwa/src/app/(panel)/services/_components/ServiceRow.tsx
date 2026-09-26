"use client";

import { useState } from "react";
import { AlertCircle, Check, ChevronDown, Copy, Link2, Loader2, QrCode, RotateCcw, Search, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { GrantRow } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { useGrantConfigs } from "../_hooks/useGrantConfigs";
import { useSubscriptionLink } from "../_hooks/useSubscriptionLink";
import { GRANT_TONES, type CapabilityName } from "../_lib/my-services";
import { formatBytes, matchesConfig, purgeCountdown } from "../_lib/service-configs";
import { remainingBytes, timeLeft, usedShare } from "../_lib/usage";
import { ConfigLines } from "./ConfigLines";
import { GrantConfigs } from "./GrantConfigs";
import { QrDialog } from "./QrDialog";
import { UsageBars } from "./UsageBars";

const S = FrontendI18nKeys.common.myServices;
const L = S.link;

/**
 * How many configs a service holds before it offers a search (user,
 * 2026-09-26: "managing 20 configs got hard"). Five fit on a phone screen;
 * past that, a name is quicker typed than scrolled to.
 */
const SEARCH_FROM = 6;

/**
 * One Grant on the "my services" page (F-502-s), laid out like a subscription
 * page (user, 2026-09-26: "confusing, not responsive, copying a config is
 * not simple — take the idea from Marzban's subscription page"). One column,
 * top to bottom:
 *
 * 1. **Name and status.**
 * 2. **Usage** — one bar, used against bought, and the days left beside it,
 *    from the row itself (no read).
 * 3. **Configs** — every line a row with copy and QR icons, and "copy all"
 *    (`ConfigLines`). Open from the start on a live row the page chose
 *    (`autoOpen`); one tap on any other.
 * 4. **Subscription link** — one row: copy, and a QR in a dialog. Read only
 *    when a copy or the QR needs it.
 * 5. **Manage** — folded: the 30 days, each server with a new link and
 *    delete, and resetting the subscription link. Everything that can break a
 *    working setup is here, never above it.
 *
 * The configs and the link are read once per row and shared by 3–5, so a
 * reset under "manage" replaces the link row 4 copies. So is the search over
 * them: one box narrows both 3 and 5, and what it hides is neither copied nor
 * deleted.
 */
export function ServiceRow({
  row,
  name,
  capabilities,
  configsAsked = 0,
  autoOpen = false,
}: {
  row: GrantRow;
  name: string | null;
  /** `capabilityNames` of this row — a name where one is published, else the key (F-114-f-c). */
  capabilities: CapabilityName[];
  /** `useGrantsPage().configsAsked` for this row: its open config list re-reads when it moves (F-111-l). */
  configsAsked?: number;
  /** Show the configs without a tap — the page gives this to its first few live rows. */
  autoOpen?: boolean;
}) {
  const { t, lang } = useLocale();
  const toMessage = useApiErrorMessage();
  const [configsOpen, setConfigsOpen] = useState(autoOpen);
  const [manageOpen, setManageOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const configs = useGrantConfigs(row.id, configsOpen || manageOpen, configsAsked);
  const sub = useSubscriptionLink(row.id);
  const [query, setQuery] = useState("");
  const searchable = (configs.rows?.length ?? 0) >= SEARCH_FROM;
  // Below the threshold a leftover query would hide configs with no box to clear it.
  const shown = configs.rows && searchable ? configs.rows.filter((c) => matchesConfig(c, query)) : configs.rows;

  const tone = GRANT_TONES[row.status];
  const countdown = purgeCountdown(row.purgeAt);

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
  const boundText = bound !== null ? (formatBytes(bound, lang) ?? bound) : "";
  const remaining = bound !== null ? (formatBytes(remainingBytes(row.consumedBytes, bound), lang) ?? "") : "";
  const usage = row.trafficUnlimited
    ? t("common", S.usageUnlimited, { consumed })
    : share !== null
      ? t("common", S.usage, { consumed, purchased: boundText })
      : t("common", S.usageUnmetered, { consumed });

  const from = formatInstant(row.startsAt, lang) ?? row.startsAt;
  const until = row.endsAt ? formatInstant(row.endsAt, lang) : null;
  const time = timeLeft(row.startsAt, row.endsAt);
  const days =
    time === null
      ? t("common", S.periodUnlimited, { from })
      : time.days === 0
        ? t("common", S.left.ended)
        : t("common", S.left.days, { days: time.days });
  const full = share !== null && share >= 1;

  async function openQr() {
    if (await sub.readLink()) setQrOpen(true);
  }

  return (
    <li className="overflow-hidden rounded-3xl border border-card-border bg-card-bg">
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 break-words text-base font-bold text-text-primary">{name ?? t("common", S.unnamed)}</h2>
          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${tone.className}`}>
            <tone.icon size={14} aria-hidden />
            {t("common", tone.labelKey)}
          </span>
        </div>

        <div>
          {share !== null && bound !== null && (
            <div
              role="img"
              aria-label={t("common", S.ring.label, { used: consumed, bought: boundText, remaining })}
              className="mb-2 h-2.5 w-full overflow-hidden rounded-full bg-bg-inner"
            >
              <div
                className={`h-full rounded-full ${full ? "bg-error" : "bg-primary"}`}
                style={{ width: `${share === 0 ? 0 : Math.max(share, 0.02) * 100}%` }}
              />
            </div>
          )}
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-text-primary">{usage}</span>
            <span className="text-text-secondary" title={until ?? undefined}>
              {days}
            </span>
          </div>
        </div>

        {/* Paid and not yet delivered (F-111-f). The page re-reads on its own
            when delivery ends, so the sentence says there is nothing to do. */}
        {row.status === "pending" && (
          <p role="status" className="rounded-2xl border border-gold/20 bg-gold-bg px-3 py-2 text-xs font-medium text-gold">
            {t("common", S.preparing)}
          </p>
        )}

        {countdown !== null && (
          <p role="status" className="rounded-2xl border border-gold/20 bg-gold-bg px-3 py-2 text-xs font-medium text-gold">
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
          <ul aria-label={t("common", S.features)} className="flex flex-wrap gap-1.5">
            {capabilities.map(({ key, name: label }) =>
              label ? (
                <li key={key} title={key} className="rounded-lg bg-bg-inner px-2 py-0.5 text-xs text-text-secondary">
                  {label}
                </li>
              ) : (
                // No published name in this language: the key, which support can read.
                <li key={key} dir="ltr" className="rounded-lg bg-bg-inner px-2 py-0.5 font-mono text-xs text-text-secondary">
                  {key}
                </li>
              ),
            )}
          </ul>
        )}

        {searchable && configs.rows && shown && (
          <div>
            <div className="flex items-center gap-2 rounded-2xl border border-card-border bg-bg-inner px-3 focus-within:border-primary">
              <Search size={16} className="shrink-0 text-text-secondary" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setQuery("");
                }}
                placeholder={t("common", S.search.placeholder)}
                aria-label={t("common", S.search.label)}
                dir="auto"
                className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-text-primary outline-none [&::-webkit-search-cancel-button]:hidden"
              />
              {query !== "" && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label={t("common", S.search.clear)}
                  title={t("common", S.search.clear)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
                >
                  <X size={16} aria-hidden />
                </button>
              )}
            </div>
            {query.trim() !== "" && (
              <p role="status" className="mt-1.5 text-xs text-text-secondary">
                {shown.length === 0
                  ? t("common", S.search.none, { query: query.trim() })
                  : t("common", S.search.count, { shown: shown.length, total: configs.rows.length })}
              </p>
            )}
          </div>
        )}

        {configsOpen ? (
          <>
            {configs.isLoading && configs.rows === null && (
              <p className="flex items-center gap-2 text-xs text-text-secondary">
                <Loader2 size={14} className="animate-spin" aria-hidden />
                {t("common", S.configs.loading)}
              </p>
            )}
            {configs.readError != null && (
              <div role="alert" className="flex items-start gap-2 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
                <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{toMessage(configs.readError)}</span>
                <button type="button" onClick={configs.reload} className="shrink-0 underline">
                  {t("common", S.retry)}
                </button>
              </div>
            )}
            {configs.rows !== null && configs.rows.length === 0 && (
              <p className="text-xs text-text-secondary">{t("common", S.configs.empty)}</p>
            )}
            {shown && shown.length > 0 && <ConfigLines rows={shown} onRenamed={configs.reload} />}
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfigsOpen(true)}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-card-border py-2.5 text-sm font-bold text-text-primary hover:bg-leaf-bg"
          >
            {t("common", S.configs.show)}
          </button>
        )}

        <section aria-label={t("common", L.label)} className="rounded-2xl bg-bg-inner p-3">
          <div className="flex items-center gap-2">
            <Link2 size={16} className="shrink-0 text-text-secondary" aria-hidden />
            <p className="min-w-0 flex-1 text-sm font-bold text-text-primary">{t("common", L.label)}</p>
            <button
              type="button"
              onClick={() => void openQr()}
              disabled={sub.isReading}
              aria-label={t("common", L.showQr)}
              title={t("common", L.showQr)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-leaf-bg hover:text-text-primary disabled:opacity-50"
            >
              <QrCode size={18} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => void sub.copy()}
              disabled={sub.isReading}
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
            >
              {sub.isReading ? (
                <Loader2 size={14} className="animate-spin" aria-hidden />
              ) : sub.copied ? (
                <Check size={14} aria-hidden />
              ) : (
                <Copy size={14} aria-hidden />
              )}
              {t("common", sub.isReading ? L.copying : sub.copied ? L.copied : L.copy)}
            </button>
          </div>
          <p className="mt-1.5 text-xs leading-5 text-text-secondary">{t("common", L.hint)}</p>
          {sub.link && sub.showLink && (
            <code className="mt-2 block select-all break-all font-mono text-xs text-text-primary" dir="ltr">
              {sub.link}
            </code>
          )}
          {sub.error && <LinkError error={sub.error} />}
        </section>

        {qrOpen && sub.link && (
          <QrDialog
            title={t("common", L.label)}
            value={sub.link}
            label={t("common", L.qrLabel)}
            copied={sub.copied}
            onCopy={() => void sub.copy()}
            onClose={() => setQrOpen(false)}
          />
        )}
      </div>

      <button
        type="button"
        aria-expanded={manageOpen}
        onClick={() => setManageOpen((o) => !o)}
        className="flex w-full items-center justify-center gap-1.5 border-t border-card-border py-3 text-xs font-bold text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
      >
        {t("common", S.manage.open)}
        <ChevronDown size={14} className={manageOpen ? "rotate-180" : ""} aria-hidden />
      </button>

      {manageOpen && (
        <div className="space-y-4 border-t border-card-border p-4 sm:p-5">
          <UsageBars grantId={row.id} />
          <GrantConfigs configs={configs} shown={shown} />

          <section aria-label={t("common", L.resetTitle)} className="rounded-2xl border border-card-border p-3">
            <p className="text-sm font-bold text-text-primary">{t("common", L.resetTitle)}</p>
            <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", L.resetHint)}</p>

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
            {/* A refused reset shows in the link row above, beside the link it did not change. */}
          </section>
        </div>
      )}
    </li>
  );
}

/** Billing's sentence for a refused read or reset, and its ref for support. */
function LinkError({ error }: { error: { message: string; ref?: string } }) {
  return (
    <div role="alert" className="mt-3 flex items-start gap-2 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-xs font-medium text-error">
      <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        {error.message}
        {error.ref && (
          <span className="mt-1 block font-mono text-[0.65rem] opacity-70" dir="ltr">
            {error.ref}
          </span>
        )}
      </span>
    </div>
  );
}
