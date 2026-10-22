"use client";

import { useState } from "react";
import { Download, FileSpreadsheet, Upload, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { MigrationRun, MigrationRunsApi } from "@/lib/billing-api";
import { MIGRATION_KEYS as K } from "../../../_lib/migration";
import { BALANCE_FILE_ACCEPT, BALANCE_TEMPLATE_HREF, BALANCE_TEMPLATE_NAME, balanceFileError } from "../../../_lib/migration-csv";
import { useMigrationMessage } from "../_hooks/useMigrationLive";
import { Alert, Button, buttonClass } from "../../../../_components/kit";

/**
 * A new balance file's run (F-209-b, billing `contract.balance-import.md`):
 * the template, the file, and its check. Billing plans every row at once and
 * answers the run previewed; the card then shows the report and the confirm.
 * The file is read here as text and sent whole — billing parses it.
 */
export function BalanceFileForm({ api, onDone, onCancel }: { api: MigrationRunsApi; onDone: (run: MigrationRun) => void; onCancel: () => void }) {
  const { t } = useLocale();
  const message = useMigrationMessage();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fileError = file ? balanceFileError(file.text) : null;

  async function pick(chosen: File | undefined) {
    setError(null);
    setFile(chosen ? { name: chosen.name, text: await chosen.text() } : null);
  }

  async function submit() {
    if (busy || !file || fileError) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await api.createCsv(file.text));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="balance-file">
      <h3 id="balance-file" className="text-sm font-bold text-text-primary">
        {t("common", K.csv.newCsv)}
      </h3>
      <p className="text-xs text-text-secondary">{t("common", K.csv.intro)}</p>
      <div className="space-y-2">
        <a href={BALANCE_TEMPLATE_HREF} download={BALANCE_TEMPLATE_NAME} className={buttonClass({ variant: "secondary", size: "sm" })}>
          <Download size={12} aria-hidden />
          {t("common", K.csv.template)}
        </a>
        <p className="text-xs text-text-secondary">{t("common", K.csv.templateHint)}</p>
      </div>
      <div className="space-y-2">
        <label className={buttonClass({ variant: "quiet", size: "sm", className: "cursor-pointer border border-card-border" })}>
          <FileSpreadsheet size={12} aria-hidden />
          {t("common", K.csv.pick)}
          <input
            type="file"
            accept={BALANCE_FILE_ACCEPT}
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              e.target.value = "";
              void pick(chosen);
            }}
          />
        </label>
        {file && (
          <p className="text-xs text-text-secondary" dir="auto">
            {t("common", K.csv.picked, { name: file.name })}
          </p>
        )}
        {fileError && <p className="text-xs text-error">{t("common", fileError)}</p>}
      </div>
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !file || fileError !== null} onClick={() => void submit()} icon={<Upload size={14} aria-hidden />}>
          {t("common", busy ? K.csv.checking : K.csv.check)}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onCancel} icon={<X size={14} aria-hidden />}>
          {t("common", K.back)}
        </Button>
      </div>
    </section>
  );
}
