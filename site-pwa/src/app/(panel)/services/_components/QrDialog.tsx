"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const S = FrontendI18nKeys.common.myServices;

/** Past this a QR code at the lowest error level no longer fits; the value is copied instead. */
export const QR_MAX = 2900;

/**
 * A QR code over the page, for a line or the subscription link (the
 * subscription page layout, user 2026-09-26). A dialog and not an inline
 * block: a 200px code opening inside a row pushed the list around and broke
 * a phone's layout.
 *
 * Rendered into `document.body`: the panel's top bar has `backdrop-blur-xl`,
 * and a `backdrop-filter` element is the containing block for `fixed`
 * descendants (`GiftCodeModal.tsx` has the same note). White behind the code
 * in both themes — a scanner needs the contrast. The value is printed under
 * it, selectable, for a device with no camera.
 */
export function QrDialog({
  title,
  value,
  label,
  copied,
  onCopy,
  onClose,
}: {
  title: string;
  value: string;
  /** The code's accessible name. */
  label: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-3xl border border-card-border bg-card-bg p-5 shadow-xl"
      >
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-bold text-text-primary" dir="auto">
            {title}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common", S.qrClose)}
            autoFocus
            className="rounded-full p-1.5 text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        {value.length > QR_MAX ? (
          <p className="mt-4 text-sm text-text-secondary">{t("common", S.lines.qrTooLong)}</p>
        ) : (
          <div role="img" aria-label={label} className="mx-auto mt-4 w-fit rounded-2xl bg-white p-3">
            <QRCodeSVG value={value} size={220} aria-hidden />
          </div>
        )}

        <code
          className="mt-4 block max-h-20 select-all overflow-y-auto break-all rounded-xl bg-bg-inner p-2 font-mono text-[11px] text-text-secondary"
          dir="ltr"
        >
          {value}
        </code>

        <button
          type="button"
          onClick={onCopy}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3 text-sm font-bold text-white"
        >
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
          {t("common", copied ? S.lines.copied : S.lines.copy)}
        </button>
      </div>
    </div>,
    document.body,
  );
}
