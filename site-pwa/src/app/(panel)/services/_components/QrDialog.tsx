"use client";

import { Check, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Button, Dialog } from "../../_components/kit";

const S = FrontendI18nKeys.common.myServices;

/** Past this a QR code at the lowest error level no longer fits; the value is copied instead. */
export const QR_MAX = 2900;

/**
 * A QR code over the page, for a line or the subscription link (the
 * subscription page layout, user 2026-09-26). A dialog and not an inline
 * block: a 200px code opening inside a row pushed the list around and broke
 * a phone's layout. The kit `Dialog` holds the trap, Esc and focus return
 * (FE-1-m, C-40). White behind the code in both themes — a scanner needs the
 * contrast. The value is printed under it, selectable, for a device with no
 * camera.
 */
export function QrDialog({
  open,
  title,
  value,
  label,
  copied,
  onCopy,
  onClose,
}: {
  open: boolean;
  title: string;
  value: string;
  /** The code's accessible name. */
  label: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={
        <span className="block truncate text-sm" dir="auto">
          {title}
        </span>
      }
    >
      {value.length > QR_MAX ? (
        <p className="text-sm text-text-secondary">{t("common", S.lines.qrTooLong)}</p>
      ) : (
        <div role="img" aria-label={label} className="mx-auto w-fit rounded-2xl bg-white p-3">
          <QRCodeSVG value={value} size={220} aria-hidden />
        </div>
      )}

      <code
        className="mt-4 block max-h-20 select-all overflow-y-auto break-all rounded-xl bg-bg-inner p-2 font-mono text-2xs text-text-secondary"
        dir="ltr"
      >
        {value}
      </code>

      <Button variant="primary" fullWidth onClick={onCopy} icon={copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />} className="mt-3">
        {t("common", copied ? S.lines.copied : S.lines.copy)}
      </Button>
    </Dialog>
  );
}
