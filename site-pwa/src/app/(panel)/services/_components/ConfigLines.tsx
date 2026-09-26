"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, Copy, CopyCheck, Download, Loader2, Pencil, QrCode, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, type UserConfigRow } from "@/lib/billing-api";
import { copyText } from "../../_lib/clipboard";
import { confFileName, lineLabel, wireguardConf } from "../_lib/config-lines";
import { configName } from "../_lib/service-configs";
import { QrDialog } from "./QrDialog";

const N = FrontendI18nKeys.common.myServices.lines;

/** The longest name billing takes (`MAX_CONFIG_LABEL_LENGTH`, ADR-0089). */
const MAX_NAME = 40;

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
 *
 * A config is named on its first line (F-307-i, ADR-0089): the name is
 * billing's to put on the lines, as `/sub` does, so a save re-reads
 * (`onRenamed`) and nothing is renamed here.
 */
export function ConfigLines({ rows, onRenamed }: { rows: UserConfigRow[]; onRenamed: () => void }) {
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
            row.lines.map((line, i) => (
              <Line key={`${row.id}:${i}`} line={line} config={i === 0 ? row : undefined} onRenamed={onRenamed} />
            ))
          ),
        )}
      </ul>
    </div>
  );
}

function Line({ line, config, onRenamed }: { line: string; config?: UserConfigRow; onRenamed: () => void }) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
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

  if (editing && config) {
    return (
      <li data-line className="px-3 py-2">
        <NameEditor
          config={config}
          onDone={(saved) => {
            setEditing(false);
            if (saved) onRenamed();
          }}
        />
      </li>
    );
  }

  return (
    <li data-line className="px-3 py-2">
      <div className="flex items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" dir="ltr" title={name}>
          {name}
        </p>
        {config && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={t("common", N.rename)}
            title={t("common", N.rename)}
            className={icon}
          >
            <Pencil size={16} aria-hidden />
          </button>
        )}
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

/**
 * A config's name, edited in place of its line: its label, or empty for the
 * default (the region, shown as the placeholder). Enter saves, Escape leaves
 * without a write; a refusal keeps what was typed, with billing's sentence.
 */
function NameEditor({ config, onDone }: { config: UserConfigRow; onDone: (saved: boolean) => void }) {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const [value, setValue] = useState(config.label ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const label = value.trim();
      await billingApi.setConfigLabel(config.id, label === "" ? null : label);
      onDone(true);
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  const icon = "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl hover:bg-leaf-bg";

  return (
    <form onSubmit={(e) => void save(e)}>
      <div className="flex items-center gap-1">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onDone(false);
          }}
          maxLength={MAX_NAME}
          placeholder={config.region}
          aria-label={t("common", N.nameField)}
          dir="auto"
          className="min-w-0 flex-1 rounded-xl border border-card-border bg-transparent px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-primary"
        />
        <button type="submit" disabled={saving} aria-label={t("common", N.nameSave)} title={t("common", N.nameSave)} className={`${icon} text-primary`}>
          {saving ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Check size={18} aria-hidden />}
        </button>
        <button type="button" onClick={() => onDone(false)} aria-label={t("common", N.nameCancel)} title={t("common", N.nameCancel)} className={`${icon} text-text-secondary`}>
          <X size={18} aria-hidden />
        </button>
      </div>
      {error != null && (
        <p role="alert" className="mt-1 text-xs font-medium text-error">
          {toMessage(error)}
        </p>
      )}
    </form>
  );
}
