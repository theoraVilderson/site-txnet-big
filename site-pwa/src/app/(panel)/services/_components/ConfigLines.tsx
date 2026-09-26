"use client";

import { useEffect, useState } from "react";
import { Check, Copy, CopyCheck, Download, QrCode } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { UserConfigRow } from "@/lib/billing-api";
import { copyText } from "../../_lib/clipboard";
import { confFileName, lineLabel, wireguardConf } from "../_lib/config-lines";
import { configName } from "../_lib/service-configs";
import { QrDialog } from "./QrDialog";

const N = FrontendI18nKeys.common.myServices.lines;

/** How long a pressed copy shows its tick. */
const TICK_MS = 2000;

/** `true` for `TICK_MS` after each `mark()` — the copy button's tick. */
function useTick(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    const id = setTimeout(() => setOn(false), TICK_MS);
    return () => clearTimeout(id);
  }, [on]);
  return [on, () => setOn(true)];
}

/**
 * A Grant's configs as one list of lines (F-307-c over F-307-a), laid out like
 * a subscription page (user, 2026-09-26: "take the idea from Marzban's"):
 * every line is a row — its name, then copy and QR as icons — so a phone fits
 * a row on one line and copying is one tap. "Copy all" puts every line on
 * the clipboard, one per line, which v2rayNG and Hiddify import at once.
 *
 * A `.conf` is offered only for a `wireguard://` line that makes a whole file,
 * built here, so the private key in the line never leaves the browser.
 * Nothing is read: the lines came with the config list.
 *
 * A server with no lines is two answers: not captured since the last new link
 * (a wait), or a panel that gives none. Both point at the subscription link.
 */
export function ConfigLines({ rows }: { rows: UserConfigRow[] }) {
  const { t } = useLocale();
  const [allCopied, markAll] = useTick();
  const lines = rows.flatMap((r) => r.lines);

  async function copyAll() {
    if (await copyText(lines.join("\n"))) markAll();
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-text-primary">{t("common", N.title)}</p>
        {lines.length > 1 && (
          <button
            type="button"
            onClick={() => void copyAll()}
            className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold text-primary hover:bg-leaf-bg"
          >
            {allCopied ? <CopyCheck size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            {t("common", allCopied ? N.allCopied : N.copyAll)}
          </button>
        )}
      </div>

      <ul aria-label={t("common", N.title)} className="mt-2 divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border">
        {rows.map((row) =>
          row.lines.length === 0 ? (
            <li key={row.id} className="px-3 py-2.5">
              <p className="truncate text-sm font-medium text-text-primary" dir="ltr">
                {configName(row)}
              </p>
              <p className="mt-0.5 text-xs text-text-secondary">
                {t("common", row.linksCapturedAt === null ? N.notCaptured : N.none)}
              </p>
            </li>
          ) : (
            row.lines.map((line, i) => <Line key={`${row.id}:${i}`} line={line} />)
          ),
        )}
      </ul>
    </div>
  );
}

function Line({ line }: { line: string }) {
  const { t } = useLocale();
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, mark] = useTick();
  const [showLine, setShowLine] = useState(false);

  const name = lineLabel(line);
  const conf = wireguardConf(line);

  async function copy() {
    if (await copyText(line)) mark();
    // No clipboard: the line is shown whole, to select by hand.
    else setShowLine(true);
  }

  const icon =
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-leaf-bg hover:text-text-primary";

  return (
    <li data-line className="px-3 py-2">
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" dir="ltr" title={name}>
          {name}
        </p>
        {conf !== null && (
          <a
            href={`data:application/octet-stream;charset=utf-8,${encodeURIComponent(conf)}`}
            download={confFileName(line)}
            aria-label={t("common", N.download)}
            title={t("common", N.download)}
            className={icon}
          >
            <Download size={18} aria-hidden />
          </a>
        )}
        <button
          type="button"
          onClick={() => setQrOpen(true)}
          aria-label={t("common", N.showQr)}
          title={t("common", N.showQr)}
          className={icon}
        >
          <QrCode size={18} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t("common", copied ? N.copied : N.copy)}
          title={t("common", N.copy)}
          className={`${icon} ${copied ? "text-primary" : ""}`}
        >
          {copied ? <Check size={18} aria-hidden /> : <Copy size={18} aria-hidden />}
        </button>
      </div>

      {showLine && (
        <code className="mt-1 block select-all break-all font-mono text-[11px] text-text-secondary" dir="ltr">
          {line}
        </code>
      )}

      {qrOpen && (
        <QrDialog
          title={name}
          value={line}
          label={t("common", N.qrLabel, { name })}
          copied={copied}
          onCopy={() => void copy()}
          onClose={() => setQrOpen(false)}
        />
      )}
    </li>
  );
}
