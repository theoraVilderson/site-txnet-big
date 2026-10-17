"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Square } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useLiveReread } from "@/hooks/useLiveReread";
import type { GroupMoveJob, GroupMoveOutcome, GroupMovesApi } from "@/lib/billing-api";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { GROUP_MOVE_EVENTS, GROUP_MOVE_KEYS as K, groupMoveChannel, groupMoveRefusalKey } from "../../_lib/group-move";
import { jobPercent } from "../../my-resellers/_lib/grant-bulk";
import { JobProblemsPager } from "../JobProblemsPager";
import { Alert, Button, useConfirm } from "../kit";

const OUTCOMES_PAGE_SIZE = 20;

/**
 * A group move as it runs (F-027-ev): progress over the total frozen at the
 * confirm, its counts, a stop, and every refused Grant with its sentence. It
 * re-reads on the job's progress event, for this job only (C-14), never by
 * polling; the refusals are read again when it ends.
 */
export function GroupMoveJobCard({
  api,
  start,
  nameOf,
  message,
  onEnded,
}: {
  api: GroupMovesApi;
  start: GroupMoveJob;
  nameOf: (grantId: string) => string;
  message: (e: unknown) => string;
  onEnded?: () => void;
}) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const { group } = usePanelSession();
  const [job, setJob] = useState(start);
  const [problems, setProblems] = useState<{ rows: GroupMoveOutcome[]; page: number; purgedAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // A parent's inline callback must not re-run the mount read on every render.
  const endedRef = useRef(onEnded);
  useEffect(() => {
    endedRef.current = onEnded;
  });

  const readProblems = useCallback(
    (page: number) =>
      api.outcomes(job.id, page, OUTCOMES_PAGE_SIZE).then(
        (p) => setProblems({ rows: p.rows, page, purgedAt: p.purgedAt }),
        (e: unknown) => setError(e),
      ),
    [api, job.id],
  );

  const settle = useCallback(
    (next: GroupMoveJob) => {
      setJob(next);
      if (next.status === "running") return;
      endedRef.current?.();
      if (next.refused + next.failed > 0) void readProblems(1);
    },
    [readProblems],
  );

  const read = useCallback(() => {
    api.job(job.id).then(settle, (e: unknown) => setError(e));
  }, [api, job.id, settle]);

  // Once on mount: a small job may end between the start's answer and the subscription.
  useEffect(read, [read]);
  useLiveReread(job.status === "running" ? groupMoveChannel(group?.current.userId ?? null) : null, GROUP_MOVE_EVENTS, read, (p) => p.jobId === job.id);

  async function cancel() {
    if (!(await confirm({ title: t("common", K.cancelConfirm), confirmLabel: t("common", K.cancel), tone: "danger" }))) return;
    setBusy(true);
    setError(null);
    try {
      settle(await api.cancel(job.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const percent = jobPercent(job);
  const progress = t("common", K.progress, { processed: String(job.processed), total: String(job.total) });
  const problemCount = job.refused + job.failed;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-card-border p-3" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs font-bold text-text-primary">{t("common", K.status[job.status])}</p>
        {job.status === "running" && (
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => void cancel()} icon={<Square size={12} aria-hidden />}>
            {t("common", K.cancel)}
          </Button>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-inner" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={progress}>
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <p className="flex flex-wrap gap-x-3 text-xs text-text-secondary">
        <span>{progress}</span>
        <span>{t("common", K.counts, { ok: String(job.ok), refused: String(job.refused), failed: String(job.failed) })}</span>
      </p>
      {job.status === "done" && <Alert tone="success">{t("common", K.doneNote)}</Alert>}
      {job.status === "cancelled" && <Alert tone="info">{t("common", K.cancelledNote)}</Alert>}
      {problems && problemCount > 0 && (
        <div className="space-y-1 text-xs">
          <p className="font-bold text-text-primary">{t("common", K.problems)}</p>
          {problems.purgedAt ? (
            <p className="text-text-secondary">{t("common", K.purged)}</p>
          ) : (
            problems.rows.map((o) =>
              o.ok ? null : (
                <p key={o.grantId} className="text-error" dir="auto">
                  {t("common", K.problemLine, { id: nameOf(o.grantId), reason: t("common", groupMoveRefusalKey(o.reason)) })}
                </p>
              ),
            )
          )}
          <JobProblemsPager page={problems.page} count={problemCount} pageSize={OUTCOMES_PAGE_SIZE} purged={problems.purgedAt !== null} onPage={(page) => void readProblems(page)} />
        </div>
      )}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
    </div>
  );
}
