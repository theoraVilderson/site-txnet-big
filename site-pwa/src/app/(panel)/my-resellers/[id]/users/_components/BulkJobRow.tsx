"use client";

import { useState } from "react";
import { Square } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { resellerGrantsApi, type BulkJob, type BulkOutcomeRow } from "@/lib/billing-api";
import { JobProblemsPager } from "../../../../_components/JobProblemsPager";
import { formatInstant } from "../../../../_lib/datetime";
import { GRANT_KEYS as G } from "../../../_lib/grant-actions";
import { BULK_ACTIONS, BULK_ACTION_NAMES, JOB_KEYS as J, bulkRefusalKey, jobPercent, type BulkAction } from "../../../_lib/grant-bulk";
import { useUserMessage } from "../[userId]/_components/useUserMessage";
import { Alert, Button, useConfirm } from "../../../../_components/kit";

const OUTCOMES_PAGE_SIZE = 20;
const STATUS_TONE: Record<BulkJob["status"], string> = {
  running: "border-primary/20 bg-leaf-bg text-primary",
  done: "border-card-border bg-bg-inner text-text-secondary",
  cancelled: "border-gold/20 bg-gold-bg text-gold",
};
const ACTION_OF: Record<string, BulkAction> = Object.fromEntries(BULK_ACTIONS.map((a) => [BULK_ACTION_NAMES[a], a]));

/** One job: what it does and to what, its progress over the frozen total, a stop while it runs, and its refused services. */
export function JobRow({ job, api, label, onChanged }: { job: BulkJob; api: ReturnType<typeof resellerGrantsApi>; label: string; onChanged: () => void }) {
  const { t, lang } = useLocale();
  const confirm = useConfirm();
  const message = useUserMessage();
  const [problems, setProblems] = useState<{ rows: BulkOutcomeRow[]; page: number; purgedAt: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const action = ACTION_OF[job.action];
  const percent = jobPercent(job);
  const problemCount = job.refused + job.failed;

  async function readProblems(page: number) {
    setBusy(true);
    setError(null);
    try {
      const answer = await api.bulkOutcomes(job.id, page, OUTCOMES_PAGE_SIZE, true);
      setProblems({ rows: answer.rows, page, purgedAt: answer.purgedAt });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!(await confirm({ title: t("common", J.cancelConfirm), tone: "danger" }))) return;
    setBusy(true);
    setError(null);
    try {
      await api.bulkCancel(job.id);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm font-bold text-text-primary" dir="auto">
          {action ? t("common", G.label[action]) : job.action} · {label}
        </p>
        <span className={`rounded-full border px-2 py-0.5 text-3xs font-medium ${STATUS_TONE[job.status]}`}>{t("common", J.status[job.status])}</span>
        {job.status === "running" && (
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => void cancel()} icon={<Square size={12} aria-hidden />}>
            {t("common", J.cancel)}
          </Button>
        )}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-bg-inner"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={t("common", J.progress, { processed: job.processed, total: job.total })}
      >
        <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <p className="flex flex-wrap gap-x-3 text-xs text-text-secondary">
        <span>{t("common", J.progress, { processed: job.processed, total: job.total })}</span>
        <span>{t("common", J.counts, { ok: job.ok, refused: job.refused, failed: job.failed })}</span>
        <span>{formatInstant(job.createdAt, lang)}</span>
      </p>
      {problemCount > 0 && (
        <Button variant="quiet" size="sm" onClick={() => (problems ? setProblems(null) : void readProblems(1))} loading={busy}>
          {t("common", problems ? J.hideProblems : J.showProblems)}
        </Button>
      )}
      {problems && (
        <div className="space-y-1 text-xs">
          {problems.purgedAt ? (
            <p className="text-text-secondary">{t("common", J.purged)}</p>
          ) : problems.rows.length === 0 ? (
            <p className="text-text-secondary">{t("common", J.problemsEmpty)}</p>
          ) : (
            problems.rows.map((o) =>
              o.ok ? null : (
                <p key={o.grantId} className="text-error">
                  {t("common", J.problemLine, { id: o.grantId.slice(0, 8), reason: t("common", bulkRefusalKey(o.reason)) })}
                </p>
              ),
            )
          )}
          <JobProblemsPager page={problems.page} count={problemCount} pageSize={OUTCOMES_PAGE_SIZE} purged={problems.purgedAt !== null} onPage={(page) => void readProblems(page)} />
        </div>
      )}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
    </li>
  );
}
