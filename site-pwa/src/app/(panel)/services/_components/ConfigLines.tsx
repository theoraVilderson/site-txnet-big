"use client";

import { useState } from "react";
import { Copy, Download, QrCode } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { UserConfigRow } from "@/lib/billing-api";
import { copyText } from "../../_lib/clipboard";
import { confFileName, lineLabel, wireguardConf } from "../_lib/config-lines";

const N = FrontendI18nKeys.common.myServices.lines;

/** Past this a QR code at the lowest error level no longer fits; the line is copied instead. */
const QR_MAX = 2900;

/**
 * A config's link lines (F-307-c over F-307-a): each one copied or shown as a
 * QR on its own, and a `.conf` file only for a `wireguard://` line that makes
 * a whole one — the file is built here, so the private key in the line never
 * leaves the browser. Nothing is read: the lines came with the config list.
 *
 * No lines is two answers: not captured since the last new key (a wait), or a
 * panel that gives none. Both point at the subscription link, which carries
 * the same configs.
 */
export function ConfigLines({ config }: { config: Pick<UserConfigRow, "lines" | "linksCapturedAt"> }) {
  const { t } = useLocale();

  if (config.lines.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-text-secondary">
        {t("common", config.linksCapturedAt === null ? N.notCaptured : N.none)}
      </p>
    );
  }

  return (
    <ul aria-label={t("common", N.title)} className="mt-2 space-y-2">
      {config.lines.map((line, i) => (
        <Line key={`${i}:${line}`} line={line} />
      ))}
    </ul>
  );
}

function Line({ line }: { line: string }) {
  const { t } = useLocale();
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showLine, setShowLine] = useState(false);

  const name = lineLabel(line);
  const conf = wireguardConf(line);

  async function copy() {
    if (await copyText(line)) setCopied(true);
    // No clipboard: the line is shown whole, to select by hand.
    else setShowLine(true);
  }

  const control =
    "flex items-center gap-1 rounded-xl border border-card-border px-2.5 py-1 text-[11px] font-bold text-text-primary hover:bg-leaf-bg";

  return (
    <li data-line className="rounded-xl border border-card-border bg-card-bg p-2.5">
      <p className="truncate font-mono text-xs font-bold text-text-primary" dir="ltr">
        {name}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void copy()} className={control}>
          <Copy size={12} aria-hidden />
          {t("common", copied ? N.copied : N.copy)}
        </button>
        <button type="button" aria-expanded={qrOpen} onClick={() => setQrOpen((o) => !o)} className={control}>
          <QrCode size={12} aria-hidden />
          {t("common", qrOpen ? N.hideQr : N.showQr)}
        </button>
        {conf !== null && (
          <a
            href={`data:application/octet-stream;charset=utf-8,${encodeURIComponent(conf)}`}
            download={confFileName(line)}
            className={control}
          >
            <Download size={12} aria-hidden />
            {t("common", N.download)}
          </a>
        )}
      </div>

      {qrOpen &&
        (line.length > QR_MAX ? (
          <p className="mt-2 text-[11px] text-text-secondary">{t("common", N.qrTooLong)}</p>
        ) : (
          // White behind the code in both themes: a scanner needs the contrast.
          <div
            role="img"
            aria-label={t("common", N.qrLabel, { name })}
            className="mx-auto mt-2 w-fit rounded-xl bg-white p-3"
          >
            <QRCodeSVG value={line} size={176} aria-hidden />
          </div>
        ))}

      {(qrOpen || showLine) && (
        <code className="mt-2 block select-all break-all font-mono text-[11px] text-text-secondary" dir="ltr">
          {line}
        </code>
      )}
    </li>
  );
}
