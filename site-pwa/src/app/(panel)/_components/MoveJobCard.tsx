"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Square } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useLiveReread } from "@/hooks/useLiveReread";
import type { JobProgress } from "@/lib/billing-api";
import { usePanelSession } from "../_context/PanelSessionContext";
import { MOVE_JOB_EVENTS, moveJobChannel, type MoveJobKeys } from "../_lib/move-job";
import { jobPercent } from "../my-resellers/_lib/grant-bulk";
import { JobProblemsPager } from "./JobProblemsPager";
import { Alert, Button, useConfirm } from "./kit";

const OUTCOMES_PAGE_SIZE = 20;

/** The three calls the card makes on one job, whichever door and kind it is. */
export interface MoveJobCalls<J, O> {
  job(jobId: string): Promise<J>;
  /** The refused and failed rows only. */
  outcomes(jobId: string, page: number, pageSize: number): Promise<{ rows: O[]; purgedAt: string | null }>;
  cancel(jobId: string): Promise<J>;
}

/** A row that did not move, as the card lists it: a stable id, how it is named, and its reason's key. */
export type MoveJobProblem = { id: string; label: string; reasonKey: string };

/**
 * A move job as it runs — Grants to another group (F-027-ev), configs to
 * another panel (F-311-ae): progress over the total frozen at the confirm, its
 * counts, a stop, and every row that did not move with its sentence. It
 * re-reads on the job's progress event, for this job only (C-14), never by
 * polling; the refusals are read again when it ends.
 */
export function MoveJobCard<J extends JobProgress & { id: string }, O>({
  api,
  start,
  keys: K,
  problemOf,
  message,
  onEnded,
  ended,
}: {
  api: MoveJobCalls<J, O>;
  start: J;
  keys: MoveJobKeys;
  /** `null` for a row that moved. */
  problemOf: (outcome: O) => MoveJobProblem | null;
  message: (e: unknown) => string;
  onEnded?: (job: J) => void;
  /** The kind's own next step once the job has ended (a retry), under its counts. */
  ended?: (job: J) => ReactNode;
}) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const { group } = usePanelSession();
  const [job, setJob] = useState(start);
  const [problems, setProblems] = useState<{ rows: MoveJobProblem[]; page: number; purgedAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // A parent's inline callbacks must not re-run the mount read on every render.
  const endedRef = useRef(onEnded);
  const problemRef = useRef(problemOf);
  useEffect(() => {
    endedRef.current = onEnded;
    problemRef.current = problemOf;
  });

  const readProblems = useCallback(
    (page: number) =>
      api.outcomes(start.id, page, OUTCOMES_PAGE_SIZE).then(
        (p) => setProblems({ rows: p.rows.flatMap((o) => problemRef.current(o) ?? []), page, purgedAt: p.purgedAt }),
        (e: unknown) => setError(e),
      ),
    [api, start.id],
  );

  const settle = useCallback(
    (next: J) => {
      setJob(next);
      if (next.status === "running") return;
      endedRef.current?.(next);
      if (next.refused + next.failed > 0) void readProblems(1);
    },
    [readProblems],
  );

  const read = useCallback(() => {
    api.job(start.id).then(settle, (e: unknown) => setError(e));
  }, [api, start.id, settle]);

  // Once on mount: a small job may end between the start's answer and the subscription.
  useEffect(read, [read]);
  useLiveReread(job.status === "running" ? moveJobChannel(group?.current.userId ?? null) : null, MOVE_JOB_EVENTS, read, (p) => p.jobId === start.id);

  async function cancel() {
    if (!(await confirm({ title: t("common", K.cancelConfirm), confirmLabel: t("common", K.cancel), tone: "danger" }))) return;
    setBusy(true);
    setError(null);
    try {
      settle(await api.cancel(start.id));
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
            problems.rows.map((p) => (
              <p key={p.id} className="text-error" dir="auto">
                {t("common", K.problemLine, { id: p.label, reason: t("common", p.reasonKey) })}
              </p>
            ))
          )}
          <JobProblemsPager page={problems.page} count={problemCount} pageSize={OUTCOMES_PAGE_SIZE} purged={problems.purgedAt !== null} onPage={(page) => void readProblems(page)} />
        </div>
      )}
      {job.status !== "running" && ended?.(job)}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
    </div>
  );
}
