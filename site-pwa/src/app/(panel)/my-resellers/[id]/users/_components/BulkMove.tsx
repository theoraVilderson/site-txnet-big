"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MoveRight } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useLiveReread } from "@/hooks/useLiveReread";
import { configMoveJobsApi, type ConfigMoveJob, type ConfigMovePanels } from "@/lib/billing-api";
import { tenantChannelOf } from "@/lib/tenant-channel";
import { usePanelSession } from "../../../../_context/PanelSessionContext";
import { formatInstant } from "../../../../_lib/datetime";
import { MOVE_JOB_EVENTS, moveJobChannel } from "../../../../_lib/move-job";
import { BULK_MOVE_KEYS as K } from "../../../_lib/bulk-move";
import { jobPercent } from "../../../_lib/grant-bulk";
import { useUserMessage } from "../[userId]/_components/useUserMessage";
import { Alert, Button } from "../../../../_components/kit";
import { BulkMoveDialog } from "./BulkMoveDialog";

/** The newest moves the card lists; older ones are the audit's. */
const RECENT_JOBS = 5;

/**
 * «جابه‌جایی گروهی» on the users page (F-311-ae, `contract.reseller-users.md`
 * rule 19b): the button that opens the sheet over the users ticked in the list
 * or one panel's, and the newest moves with their progress, each opened again
 * in the sheet. The list is read on mount and again on a move's progress event
 * for this tenant (C-14) — the starter on its `user:`, the tenant's staff on
 * its `tenant:` — never on a timer.
 */
export function BulkMove({ id, tickedUserIds, onClearTicks }: { id: string; tickedUserIds: string[]; onClearTicks: () => void }) {
  const { t, lang } = useLocale();
  const message = useUserMessage();
  const { me, group } = usePanelSession();
  const api = useMemo(() => configMoveJobsApi(id), [id]);
  const [jobs, setJobs] = useState<ConfigMoveJob[] | null>(null);
  const [panels, setPanels] = useState<ConfigMovePanels | null>(null);
  // The sheet: closed, the form (`job: null`), or one job.
  const [sheet, setSheet] = useState<{ job: ConfigMoveJob | null } | null>(null);
  const [error, setError] = useState<unknown>(null);

  const readJobs = useCallback(() => {
    api.jobs(1, RECENT_JOBS).then(
      (page) => setJobs(page.rows),
      (e: unknown) => setError(e),
    );
  }, [api]);
  useEffect(readJobs, [readJobs]);
  const ours = (p: Record<string, unknown>) => p.tenantId === id;
  useLiveReread(moveJobChannel(group?.current.userId ?? null), MOVE_JOB_EVENTS, readJobs, ours);
  useLiveReread(tenantChannelOf(me ?? null), MOVE_JOB_EVENTS, readJobs, ours);

  // The pickers, once: when the sheet first opens, or to name the targets of the moves listed.
  const wantsPanels = sheet !== null || (jobs?.length ?? 0) > 0;
  useEffect(() => {
    if (!wantsPanels || panels) return;
    let alive = true;
    api.panels().then(
      (p) => alive && setPanels(p),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [api, wantsPanels, panels]);

  const panelName = (panelId: string) => panels?.targets.find((p) => p.id === panelId)?.name ?? "…";
  const started = (job: ConfigMoveJob) => {
    setSheet({ job });
    readJobs();
  };

  return (
    <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-text-primary">{t("common", K.open)}</h2>
          <p className="text-xs leading-5 text-text-secondary">{t("common", K.cardIntro)}</p>
        </div>
        {tickedUserIds.length > 0 && (
          <Button variant="quiet" size="sm" onClick={onClearTicks}>
            {t("common", K.clearTicks)}
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => setSheet({ job: null })} icon={<MoveRight size={12} aria-hidden />}>
          {t("common", K.open)}
          {tickedUserIds.length > 0 && ` (${tickedUserIds.length})`}
        </Button>
      </div>

      {jobs && jobs.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-bold text-text-primary">{t("common", K.jobs)}</p>
          <ul className="divide-y divide-card-border rounded-xl border border-card-border">
            {jobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1 text-text-primary" dir="auto">
                  {t("common", K.jobLine, { panel: panelName(job.toPanelId), when: formatInstant(job.createdAt, lang) ?? "" })}
                </span>
                <span className="text-text-secondary">
                  {t("common", K.status[job.status])} · {jobPercent(job)}%
                </span>
                <Button variant="quiet" size="sm" onClick={() => setSheet({ job })}>
                  {t("common", K.show)}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}

      {sheet && (
        <BulkMoveDialog
          api={api}
          panels={panels}
          tickedUserIds={tickedUserIds}
          job={sheet.job}
          message={message}
          onStarted={started}
          onEnded={readJobs}
          onClose={() => setSheet(null)}
        />
      )}
    </section>
  );
}
