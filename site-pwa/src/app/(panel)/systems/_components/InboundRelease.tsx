"use client";

import { useCallback, useEffect, useState } from "react";
import { Square } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useLiveReread } from "@/hooks/useLiveReread";
import { billingApi, type EvictOrphans, type InboundReleaseJob, type InboundSeller, type ReleaseMode } from "@/lib/billing-api";
import { tenantChannelOf } from "@/lib/tenant-channel";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { jobPercent } from "../../my-resellers/_lib/grant-bulk";
import { RELEASE_EVENTS, validateRelease, type ReleaseForm } from "../_lib/inbound-audience";
import { ORPHAN_CHOICES } from "../_lib/panel-groups";
import { SYSTEMS_KEYS } from "../_lib/systems";
import { useSystemsError } from "./parts";
import { Alert, Button, RadioCards, Textarea, useConfirm } from "../../_components/kit";

const R = SYSTEMS_KEYS.release;
const E = SYSTEMS_KEYS.groups.evict;

const MODES: { value: ReleaseMode; label: string; hint: string }[] = [
  { value: "move", label: R.move, hint: R.moveHint },
  { value: "empty", label: R.empty, hint: R.emptyHint },
];
const ORPHAN_LABELS: Record<EvictOrphans, { label: string; hint: string }> = { pause: { label: E.pause, hint: E.pauseHint }, refund: { label: E.refund, hint: E.refundHint } };

/**
 * Taking groups off an inbound their users are on (F-027-eu -> billing
 * F-027-es, ADR-0127 decision 6): the admin's choice, never a side effect —
 * `move` (each user to their group's next placement) or `empty` (their
 * config there removed; a user left with nothing paused or refunded), with a
 * reason. It runs as a job; the card re-reads it on each batch's progress
 * event (C-14) and stops it on request. The listing changes only when it
 * ends, so `onEnded` re-reads the inbound then.
 */
export function InboundRelease({
  panelId,
  remoteId,
  groups,
  jobId,
  onEnded,
}: {
  panelId: string;
  remoteId: string;
  /** The groups losing it, with their users there; ignored once a job runs. */
  groups: InboundSeller[];
  /** A job already running on this inbound: watched, not started again. */
  jobId: string | null;
  onEnded: () => void;
}) {
  const { t } = useLocale();
  const message = useSystemsError();
  const confirm = useConfirm();
  const { me } = usePanelSession();
  // Pause first, as an evict offers it (F-027-eg): nothing is refunded by a slip.
  const [form, setForm] = useState<ReleaseForm>({ mode: "move", orphans: ORPHAN_CHOICES[0], reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  // One per confirm: a double click is the same job (billing `request_reused` on another body).
  const [requestId] = useState(() => crypto.randomUUID());
  const [job, setJob] = useState<InboundReleaseJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const watched = job?.id ?? jobId;

  const read = useCallback(() => {
    if (!watched) return () => undefined;
    let live = true;
    billingApi.inboundReleaseJob(watched).then(
      (next) => {
        if (!live) return;
        setJob(next);
        if (next.status !== "running") onEnded();
      },
      (e: unknown) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [watched, onEnded]);

  // A release already running when the inbound is opened: read it once, then on its events.
  useEffect(() => (jobId ? read() : undefined), [jobId, read]);

  useLiveReread(job?.status === "running" || (!job && jobId) ? tenantChannelOf(me) : null, RELEASE_EVENTS, () => read(), (p) => p.jobId === watched);

  const start = async () => {
    const checked = validateRelease(form, groups.map((g) => g.groupId), requestId);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      const started = await billingApi.releaseInbound(panelId, remoteId, checked.body);
      setJob(started);
      if (started.status !== "running") onEnded();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!job || !(await confirm({ title: t("common", R.cancelConfirm), tone: "danger" }))) return;
    setBusy(true);
    try {
      setJob(await billingApi.cancelInboundRelease(job.id));
      onEnded();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (job || jobId) return <JobCard job={job} busy={busy} error={error} onCancel={() => void cancel()} />;

  return (
    <div className="flex flex-col gap-3">
      <Alert tone="error">
        <p className="font-bold">{t("common", R.title)}</p>
        <p className="mt-1 leading-5">{t("common", R.intro)}</p>
        <ul className="mt-1 list-inside list-disc">
          {groups.map((g) => (
            <li key={g.groupId}>{t("common", R.group, { group: g.name, count: String(g.clients) })}</li>
          ))}
        </ul>
      </Alert>
      <p className="text-xs font-bold text-text-primary">{t("common", R.mode)}</p>
      <RadioCards<ReleaseMode>
        ariaLabel={t("common", R.mode)}
        columns={1}
        value={form.mode}
        onChange={(mode) => setForm({ ...form, mode })}
        options={MODES.map((m) => ({ value: m.value, label: t("common", m.label), description: t("common", m.hint) }))}
      />
      {form.mode === "empty" && (
        <>
          <p className="text-xs font-bold text-text-primary">{t("common", R.orphans)}</p>
          <RadioCards<EvictOrphans>
            ariaLabel={t("common", R.orphans)}
            columns={1}
            value={form.orphans ?? ORPHAN_CHOICES[0]}
            onChange={(orphans) => setForm({ ...form, orphans })}
            options={ORPHAN_CHOICES.map((v) => ({ value: v, label: t("common", ORPHAN_LABELS[v].label), description: t("common", ORPHAN_LABELS[v].hint) }))}
          />
        </>
      )}
      <label className="flex flex-col gap-1 text-xs text-text-secondary">
        {t("common", R.reason)}
        <Textarea value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} rows={2} />
        {errors.reason && <span className="text-error">{t("common", errors.reason)}</span>}
      </label>
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      <div>
        <Button variant="primary" size="sm" onClick={() => void start()} loading={busy}>
          {t("common", R.start)}
        </Button>
      </div>
    </div>
  );
}

/** The job as it stands: status, progress over the frozen total, its counts, a stop while it runs, and what its end means. */
function JobCard({ job, busy, error, onCancel }: { job: InboundReleaseJob | null; busy: boolean; error: unknown; onCancel: () => void }) {
  const { t } = useLocale();
  const message = useSystemsError();
  if (!job) return error !== null ? <Alert tone="error">{message(error)}</Alert> : <p className="text-xs text-text-secondary">{t("common", SYSTEMS_KEYS.loading)}</p>;
  const progress = t("common", R.progress, { processed: String(job.processed), total: String(job.total) });
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-card-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs font-bold text-text-primary">{t("common", R.status[job.status])}</p>
        {job.status === "running" && (
          <Button variant="quiet" size="sm" disabled={busy} onClick={onCancel} icon={<Square size={12} aria-hidden />}>
            {t("common", R.cancel)}
          </Button>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-inner" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={jobPercent(job)} aria-label={progress}>
        <div className="h-full bg-primary" style={{ width: `${jobPercent(job)}%` }} />
      </div>
      <p className="flex flex-wrap gap-x-3 text-xs text-text-secondary">
        <span>{progress}</span>
        <span>{t("common", R.counts, { ok: String(job.ok), refused: String(job.refused), failed: String(job.failed) })}</span>
      </p>
      {job.status === "done" && <Alert tone="success">{t("common", R.doneNote)}</Alert>}
      {job.status === "cancelled" && <Alert tone="info">{t("common", R.cancelledNote)}</Alert>}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
    </div>
  );
}
