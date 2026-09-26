"use client";

import { useState } from "react";
import { AlertCircle, Copy, Loader2, QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { GrantConfigsState } from "../_hooks/useGrantConfigs";
import type { SubscriptionLinkState } from "../_hooks/useSubscriptionLink";
import { configName } from "../_lib/service-configs";
import { ConfigLines } from "./ConfigLines";

const S = FrontendI18nKeys.common.myServices;
const K = S.connect;
const L = S.link;

/**
 * "Connect to this service" (user, 2026-09-26): the one thing a user comes to
 * this page for, one press from the row.
 *
 * **Each server's own lines first, the subscription link under them** (user,
 * 2026-09-26: lines first). A line is the config itself — copy it or scan it.
 * The link is the same servers in one, which an app keeps up to date after a
 * new key; it is read only when a copy or the QR needs it.
 *
 * Nothing here changes anything: a new key, delete and reset live under the
 * row's "details", so a user looking for how to connect cannot break it.
 */
export function ConnectPanel({ configs, sub }: { configs: GrantConfigsState; sub: SubscriptionLinkState }) {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const [qrOpen, setQrOpen] = useState(false);

  async function toggleQr() {
    if (qrOpen) return setQrOpen(false);
    if (await sub.readLink()) setQrOpen(true);
  }

  const { rows } = configs;

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-text-secondary">{t("common", K.step)}</p>

      {configs.isLoading && rows === null && (
        <p className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", S.configs.loading)}
        </p>
      )}

      {configs.readError != null && (
        <div role="alert" className="flex items-start gap-2 rounded-2xl border border-error-border bg-error-bg px-3 py-2 text-sm font-medium text-error">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{toMessage(configs.readError)}</span>
          <button type="button" onClick={configs.reload} className="shrink-0 underline">
            {t("common", S.retry)}
          </button>
        </div>
      )}

      {rows !== null && rows.length === 0 && <p className="text-sm text-text-secondary">{t("common", S.configs.empty)}</p>}

      {rows !== null && rows.length > 0 && (
        <ul className="space-y-4">
          {rows.map((row) => (
            <li key={row.id} className="space-y-2">
              {/* A single line already carries its server's name; none or
                  several need to say whose they are. */}
              {rows.length > 1 && row.lines.length !== 1 && (
                <p className="text-xs font-bold text-text-secondary" dir="auto">
                  {configName(row)}
                </p>
              )}
              <ConfigLines config={row} />
            </li>
          ))}
        </ul>
      )}

      <section aria-label={t("common", L.label)} className="rounded-2xl border border-card-border bg-bg-inner p-4">
        <p className="text-sm font-bold text-text-primary">{t("common", L.label)}</p>
        <p className="mt-1 text-xs leading-6 text-text-secondary">{t("common", L.hint)}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void sub.copy()}
            disabled={sub.isReading}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
          >
            {sub.isReading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Copy size={14} aria-hidden />}
            {t("common", sub.isReading ? L.copying : sub.copied ? L.copied : L.copy)}
          </button>
          <button
            type="button"
            onClick={() => void toggleQr()}
            disabled={sub.isReading}
            className="flex items-center gap-1.5 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
          >
            <QrCode size={14} aria-hidden />
            {t("common", qrOpen ? L.hideQr : L.showQr)}
          </button>
        </div>

        {sub.link && (qrOpen || sub.showLink) && (
          <div className="mt-3 space-y-3">
            {qrOpen && (
              // White behind the code in both themes: a scanner needs the contrast.
              <div role="img" aria-label={t("common", L.qrLabel)} className="mx-auto w-fit rounded-xl bg-white p-3">
                <QRCodeSVG value={sub.link} size={200} aria-hidden />
              </div>
            )}
            <code className="block select-all break-all font-mono text-xs text-text-primary" dir="ltr">
              {sub.link}
            </code>
          </div>
        )}

        {sub.error && <LinkError error={sub.error} />}
      </section>
    </div>
  );
}

/** Billing's sentence for a refused read or reset, and its ref for support. */
export function LinkError({ error }: { error: { message: string; ref?: string } }) {
  return (
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
  );
}
