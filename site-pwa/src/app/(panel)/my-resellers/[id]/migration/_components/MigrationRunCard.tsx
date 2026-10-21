"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Undo2, Upload, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { MigrationRun, MigrationRunsApi } from "@/lib/billing-api";
import { formatInstant } from "../../../../_lib/datetime";
import { driverLabel } from "../../../../systems/_lib/systems";
import { IMPORT_FAMILIES, MIGRATION_KEYS as K, commitProgress, isCancellable, rollbackDaysLeft, stageOf, type ImportFamily, type RunStage } from "../../../_lib/migration";
import { useFailureText, useMigrationLive, useMigrationMessage } from "../_hooks/useMigrationLive";
import { InboundMapping } from "./InboundMapping";
import { LegacyHostStep } from "./LegacyHostStep";
import { MigrationReport } from "./MigrationReport";
import { SourceLoginForm } from "./SourceLoginForm";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { Alert, Button, Card, CardHeader, StatusPill, useConfirm, type Tone } from "../../../../_components/kit";

const STAGE_TONE: Record<RunStage, Tone> = {
  login: "neutral",
  mapping: "warning",
  reading: "info",
  report: "info",
  importing: "info",
  imported: "success",
  rollingBack: "info",
  closed: "neutral",
};

const importFamilyOf = (f: string): ImportFamily | undefined => IMPORT_FAMILIES.find((x) => x === f);

/**
 * One import, start to end (F-201-f): connect, map, the dry run's report,
 * confirm, live progress, the rollback with its days left, and the old
 * address pointed here (F-204-b). Every step is the
 * run's status as billing answers it (`stageOf`); the card re-reads it on
 * the run's progress event (C-14), never by polling.
 */
export function MigrationRunCard({ api, tenantId, runId }: { api: MigrationRunsApi; tenantId: string; runId: string }) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const message = useMigrationMessage();
  const failureText = useFailureText();
  const [run, setRun] = useState<MigrationRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const read = useCallback(() => {
    api.get(runId).then(setRun, (e: unknown) => setError(e));
  }, [api, runId]);
  useEffect(read, [read]);
  useMigrationLive(tenantId, read, runId);

  async function act(ask: { title: string; label: string; danger?: boolean }, call: (id: string) => Promise<MigrationRun>) {
    if (busy || !run) return;
    if (!(await confirm({ title: ask.title, confirmLabel: ask.label, tone: ask.danger ? "danger" : "default" }))) return;
    setBusy(true);
    setError(null);
    try {
      setRun(await call(run.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!run) return error !== null ? <Alert tone="error">{message(error)}</Alert> : <TableSkeleton rows={3} columns={2} />;

  const stage = stageOf(run);
  const issued = run.plannedCreate + run.plannedUpdate;
  const days = rollbackDaysLeft(run);
  const family = importFamilyOf(run.sourceFamily);
  const commit = () => act({ title: t("common", K.commitConfirm, { count: String(issued) }), label: t("common", K.commit, { count: String(issued) }) }, api.commit);
  const rollback = () => act({ title: t("common", K.rollbackConfirm), label: t("common", K.rollback), danger: true }, api.rollback);
  const cancel = () => act({ title: t("common", K.cancelConfirm), label: t("common", K.cancel), danger: true }, api.cancel);

  return (
    <Card className="space-y-5">
      <CardHeader
        title={<span dir="auto">{t("common", K.historyRow, { family: driverLabel(run.sourceFamily), address: run.sourceAddress })}</span>}
        subtitle={t("common", K.startedAt, { when: formatInstant(run.createdAt, lang) ?? "" })}
        actions={<StatusPill tone={STAGE_TONE[stage]}>{t("common", K.status[run.status])}</StatusPill>}
      />
      {run.failureReason && (stage === "login" || stage === "mapping") && <Alert tone="warning">{failureText(run.failureReason)}</Alert>}

      {stage === "login" && (family ? <SourceLoginForm api={api} run={run} family={family} onDone={setRun} /> : <Alert tone="error">{failureText("no_driver")}</Alert>)}
      {(stage === "mapping" || stage === "report") && <InboundMapping api={api} tenantId={tenantId} run={run} onSaved={setRun} />}
      {stage === "reading" && <Progress label={t("common", K.reading)} />}
      {stage === "importing" && <CommitProgress run={run} />}
      {stage === "rollingBack" && <Progress label={t("common", K.rollingBack)} />}

      {stage === "report" && (
        <div className="space-y-3">
          <p className="text-sm font-bold text-text-primary">
            {t("common", K.report.counts, { create: String(run.plannedCreate), update: String(run.plannedUpdate), skip: String(run.plannedSkip) })}
          </p>
          {issued === 0 ? (
            <Alert tone="info">{t("common", K.commitNothing)}</Alert>
          ) : (
            <Button disabled={busy} onClick={() => void commit()} icon={<Upload size={14} aria-hidden />}>
              {t("common", K.commit, { count: String(issued) })}
            </Button>
          )}
        </div>
      )}
      {(stage === "imported" || run.status === "rolled_back") && (
        <p className="text-sm font-bold text-text-primary">{t("common", K.importedNote, { ok: String(run.committedItems), failed: String(run.failedItems) })}</p>
      )}
      {stage === "imported" &&
        (days !== null ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" disabled={busy} onClick={() => void rollback()} icon={<Undo2 size={14} aria-hidden />}>
              {t("common", K.rollback)}
            </Button>
            <span className="text-xs text-text-secondary">{t("common", K.rollbackDays, { days: String(days) })}</span>
          </div>
        ) : (
          <p className="text-xs text-text-secondary">{t("common", K.rollbackClosed)}</p>
        ))}
      {stage === "imported" && <LegacyHostStep api={api} tenantId={tenantId} family={run.sourceFamily} />}
      {run.status === "rolled_back" && <Alert tone="success">{t("common", K.rolledBackNote)}</Alert>}
      {(run.status === "cancelled" || run.status === "expired") && <Alert tone="info">{t("common", K.closed)}</Alert>}

      {stage !== "login" && stage !== "reading" && run.plannedCreate + run.plannedUpdate + run.plannedSkip > 0 && <MigrationReport api={api} run={run} />}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      {isCancellable(run) && (
        <Button variant="quiet" size="sm" disabled={busy} onClick={() => void cancel()} icon={<X size={12} aria-hidden />}>
          {t("common", K.cancel)}
        </Button>
      )}
    </Card>
  );
}

function Progress({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-text-secondary" aria-live="polite">
      <Loader2 size={14} className="animate-spin" aria-hidden />
      {label}
    </p>
  );
}

/** The commit's bar over what it issues; the counts arrive with each batch's event. */
function CommitProgress({ run }: { run: MigrationRun }) {
  const { t } = useLocale();
  const { done, total, percent } = commitProgress(run);
  const label = t("common", K.importing, { done: String(done), total: String(total) });
  return (
    <div className="space-y-2" aria-live="polite">
      <p className="text-sm text-text-secondary">{label}</p>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-inner" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={label}>
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
