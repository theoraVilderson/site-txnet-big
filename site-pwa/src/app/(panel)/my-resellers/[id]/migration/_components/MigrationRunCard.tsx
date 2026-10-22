"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RotateCw, Undo2, Upload, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { MigrationRun, MigrationRunsApi } from "@/lib/billing-api";
import { formatInstant } from "../../../../_lib/datetime";
import { IMPORT_FAMILIES, MIGRATION_KEYS as K, commitProgress, isCancellable, rollbackDaysLeft, stageOf, type ImportFamily, type RunStage } from "../../../_lib/migration";
import { runTitleOf } from "../../../_lib/migration-link";
import { useFailureText, useMigrationLive, useMigrationMessage } from "../_hooks/useMigrationLive";
import { InboundMapping } from "./InboundMapping";
import { LegacyHostStep } from "./LegacyHostStep";
import { LinkReview } from "./LinkReview";
import { MigrationReport } from "./MigrationReport";
import { SourceLoginForm } from "./SourceLoginForm";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { Alert, Button, Card, CardHeader, StatusPill, useConfirm, type Tone } from "../../../../_components/kit";

const STAGE_TONE: Record<RunStage, Tone> = {
  login: "neutral",
  mapping: "warning",
  retry: "warning",
  reading: "info",
  report: "info",
  importing: "info",
  imported: "success",
  rollingBack: "info",
  closed: "neutral",
};

const importFamilyOf = (f: string | null): ImportFamily | undefined => IMPORT_FAMILIES.find((x) => x === f);

/**
 * One import, start to end (F-201-f) — or one user's from an old link
 * (F-201-h-1), its read, review and correction in place of the connect and
 * the mapping; or a balance file's (F-209-b), its report at once and no old
 * address to point: connect, map, the dry run's report,
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
  const isLink = run.kind === "link";
  const isPanel = run.kind === "panel";
  const title = runTitleOf(run);
  // A link run is committed once its product is chosen (billing's `variant_unchosen`).
  const committable = issued > 0 && (!isLink || run.variantId !== null);
  const commitKeys = { panel: { title: K.commitConfirm, label: K.commit }, csv: { title: K.csv.commitConfirm, label: K.csv.commit }, link: { title: K.link.commitConfirm, label: K.link.commit } }[run.kind];
  const commitText = { title: t("common", commitKeys.title, { count: String(issued) }), label: t("common", commitKeys.label, { count: String(issued) }) };
  const commit = () => act(commitText, api.commit);
  const recheckLabel = t("common", run.kind === "csv" ? K.csv.recheck : K.link.retry);
  const reread = () => act({ title: recheckLabel, label: recheckLabel }, api.preview);
  const rollback = () => act({ title: t("common", run.kind === "csv" ? K.csv.rollbackConfirm : K.rollbackConfirm), label: t("common", K.rollback), danger: true }, api.rollback);
  const cancel = () => act({ title: t("common", K.cancelConfirm), label: t("common", K.cancel), danger: true }, api.cancel);

  return (
    <Card className="space-y-5">
      <CardHeader
        title={<span dir="auto">{t("common", title.key, title.values)}</span>}
        subtitle={t("common", K.startedAt, { when: formatInstant(run.createdAt, lang) ?? "" })}
        actions={<StatusPill tone={STAGE_TONE[stage]}>{t("common", K.status[run.status])}</StatusPill>}
      />
      {run.failureReason && (stage === "login" || stage === "mapping" || stage === "retry") && <Alert tone="warning">{failureText(run.failureReason, run.kind)}</Alert>}
      {stage === "retry" && (
        <Button variant="secondary" disabled={busy} onClick={() => void reread()} icon={<RotateCw size={14} aria-hidden />}>
          {recheckLabel}
        </Button>
      )}

      {stage === "login" && (family ? <SourceLoginForm api={api} run={run} family={family} onDone={setRun} /> : <Alert tone="error">{failureText("no_driver")}</Alert>)}
      {isPanel && (stage === "mapping" || stage === "report") && <InboundMapping api={api} tenantId={tenantId} run={run} onSaved={setRun} />}
      {isLink && stage === "report" && <LinkReview api={api} tenantId={tenantId} run={run} onSaved={setRun} />}
      {stage === "reading" && <Progress label={t("common", { panel: K.reading, link: K.link.reading, csv: K.csv.checking }[run.kind])} />}
      {stage === "importing" && <CommitProgress run={run} />}
      {stage === "rollingBack" && <Progress label={t("common", K.rollingBack)} />}

      {stage === "report" && (
        <div className="space-y-3">
          {!isLink && (
            <p className="text-sm font-bold text-text-primary">
              {t("common", K.report.counts, { create: String(run.plannedCreate), update: String(run.plannedUpdate), skip: String(run.plannedSkip) })}
            </p>
          )}
          {!isLink && issued === 0 && <Alert tone="info">{t("common", isPanel ? K.commitNothing : K.csv.commitNothing)}</Alert>}
          <div className="flex flex-wrap items-center gap-2">
            {committable && (
              <Button disabled={busy} onClick={() => void commit()} icon={<Upload size={14} aria-hidden />}>
                {commitText.label}
              </Button>
            )}
            {/* A person the file named may have been added since: billing plans the kept rows again (rule 3). */}
            {run.kind === "csv" && (
              <Button variant="secondary" disabled={busy} onClick={() => void reread()} icon={<RotateCw size={14} aria-hidden />}>
                {recheckLabel}
              </Button>
            )}
          </div>
          {run.kind === "csv" && run.plannedSkip > 0 && <p className="text-xs text-text-secondary">{t("common", K.csv.recheckHint)}</p>}
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
      {stage === "imported" && run.kind !== "csv" && <LegacyHostStep api={api} tenantId={tenantId} family={run.sourceFamily ?? ""} />}
      {run.status === "rolled_back" && <Alert tone="success">{t("common", K.rolledBackNote)}</Alert>}
      {(run.status === "cancelled" || run.status === "expired") && <Alert tone="info">{t("common", K.closed)}</Alert>}

      {stage !== "login" && stage !== "reading" && !(isLink && stage === "report") && run.plannedCreate + run.plannedUpdate + run.plannedSkip > 0 && <MigrationReport api={api} run={run} />}
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
