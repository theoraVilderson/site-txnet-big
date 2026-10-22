"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { ConfigMoveJob, ConfigMoveJobsApi, ConfigMoveOutcome, ConfigMovePanels, ConfigMoveSource } from "@/lib/billing-api";
import { MoveJobCard } from "../../../../_components/MoveJobCard";
import { MoveSheetActions, useMoveCount, useMoveStart } from "../../../../_components/move-sheet";
import { Alert, Button, Dialog, Field, NativeSelect, RadioCards, Textarea, useConfirm } from "../../../../_components/kit";
import { BULK_MOVE_KEYS as K, bulkMoveOutcomeKey, bulkMoveRefusal, bulkMoveTargets, retrySelection, sourceReady, validateBulkMove, type BulkMoveForm } from "../../../_lib/bulk-move";

/** How many characters of a config's id name it in a refusal line. */
const SHORT_ID = 8;

type SourceKind = "ticked" | "panel";

/**
 * «جابه‌جایی گروهی» (F-311-ae -> billing F-311-ad, D-63): the configs of the
 * users ticked, or every live config on one panel, to another panel.
 *
 *  - **the confirm names billing's count** for this source and target, and the
 *    start waits for it — the selection is frozen at the start;
 *  - **one sheet, one `requestId`**: a double click starts one job;
 *  - **the job is shown live** (`MoveJobCard`); closing the sheet never stops it;
 *  - **retry the failed** asks again for the ended job's own source and target.
 */
export function BulkMoveDialog({
  api,
  panels,
  tickedUserIds,
  job,
  message,
  onStarted,
  onEnded,
  onClose,
}: {
  api: ConfigMoveJobsApi;
  /** `null` while the pickers are read. */
  panels: ConfigMovePanels | null;
  tickedUserIds: string[];
  /** The job to show; none opens the form. */
  job: ConfigMoveJob | null;
  /** The page's own sentence for an error that is not a move's. */
  message: (e: unknown) => string;
  onStarted: (job: ConfigMoveJob) => void;
  onEnded: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const say = (e: unknown) => {
    const key = bulkMoveRefusal((e as { reason?: unknown } | null)?.reason);
    return key ? t("common", key) : message(e);
  };
  const panelName = (panelId: string) => panels?.targets.find((p) => p.id === panelId)?.name ?? panelId.slice(0, SHORT_ID);
  return (
    <Dialog open onClose={onClose} title={t("common", K.title)} size="md">
      {job ? (
        <MoveJobCard
          key={job.id}
          api={api}
          start={job}
          keys={K}
          problemOf={(o: ConfigMoveOutcome) => (o.ok ? null : { id: o.configId, label: o.configId.slice(0, SHORT_ID), reasonKey: bulkMoveOutcomeKey(o.reason) })}
          message={say}
          onEnded={onEnded}
          ended={(ended) => <RetryFailed api={api} job={ended} panelName={panelName(ended.toPanelId)} message={say} onStarted={onStarted} />}
        />
      ) : panels === null ? (
        <p className="text-xs text-text-secondary">{t("common", K.loading)}</p>
      ) : (
        <MoveForm api={api} panels={panels} tickedUserIds={tickedUserIds} message={say} onStarted={onStarted} onCancel={onClose} />
      )}
    </Dialog>
  );
}

/** Who, where to, billing's count for it, a reason, and the start behind a confirm. */
function MoveForm({
  api,
  panels,
  tickedUserIds,
  message,
  onStarted,
  onCancel,
}: {
  api: ConfigMoveJobsApi;
  panels: ConfigMovePanels;
  tickedUserIds: string[];
  message: (e: unknown) => string;
  onStarted: (job: ConfigMoveJob) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const [kind, setKind] = useState<SourceKind>(tickedUserIds.length > 0 ? "ticked" : "panel");
  const [sourcePanelId, setSourcePanelId] = useState("");
  const [form, setForm] = useState<BulkMoveForm>({ toPanelId: "", reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [requestId] = useState(() => crypto.randomUUID());

  const source: ConfigMoveSource = kind === "ticked" ? { userIds: tickedUserIds } : { panelId: sourcePanelId };
  const targets = bulkMoveTargets(panels.targets, source);
  const toPanelId = targets.some((p) => p.id === form.toPanelId) ? form.toPanelId : "";
  const ready = sourceReady(source) && toPanelId !== "";
  const { count, error: countError } = useMoveCount(ready ? { source, toPanelId } : null, api.count);
  const starting = useMoveStart(onStarted);
  const error = starting.error ?? countError;

  async function start() {
    const checked = validateBulkMove({ ...form, toPanelId }, source, requestId);
    if (!checked.ok) return setErrors(checked.errors);
    setErrors({});
    if (!count) return;
    const panel = targets.find((p) => p.id === toPanelId)?.name ?? "";
    if (!(await confirm({ title: t("common", K.confirm, { count: String(count), panel }), confirmLabel: t("common", K.start) }))) return;
    await starting.run(() => api.start(checked.body));
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-5 text-text-secondary">{t("common", K.intro)}</p>
      <RadioCards<SourceKind>
        ariaLabel={t("common", K.source)}
        value={kind}
        onChange={setKind}
        options={[
          { value: "ticked", label: t("common", K.sourceTicked, { count: String(tickedUserIds.length) }), description: tickedUserIds.length === 0 ? t("common", K.noTicks) : undefined, disabled: tickedUserIds.length === 0 },
          { value: "panel", label: t("common", K.sourcePanel) },
        ]}
      />
      {kind === "panel" && (
        <Field label={t("common", K.sourcePanel)} error={errors.source && t("common", errors.source)}>
          <NativeSelect value={sourcePanelId} onChange={(e) => setSourcePanelId(e.target.value)}>
            <option value="">{t("common", K.sourcePanelPick)}</option>
            {panels.sources.map((p) => (
              <option key={p.id} value={p.id}>
                {t("common", K.panelOption, { name: p.name, region: p.region, grants: String(p.grants) })}
                {p.retired ? ` · ${t("common", K.retired)}` : ""}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      {targets.length === 0 ? (
        <Alert tone="info">{t("common", K.noTargets)}</Alert>
      ) : (
        <Field label={t("common", K.target)} error={errors.toPanelId && t("common", errors.toPanelId)}>
          <NativeSelect value={toPanelId} onChange={(e) => setForm({ ...form, toPanelId: e.target.value })}>
            <option value="">{t("common", K.targetPick)}</option>
            {targets.map((p) => (
              <option key={p.id} value={p.id}>
                {t("common", K.targetOption, { name: p.name, region: p.region })}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      {ready && (
        <p className="text-xs font-bold text-text-primary" role="status">
          {count === null ? t("common", K.counting) : count === 0 ? t("common", K.previewEmpty) : t("common", K.preview, { count: String(count) })}
        </p>
      )}
      <Field label={t("common", K.reason)} error={errors.reason && t("common", errors.reason)}>
        <Textarea value={form.reason} maxLength={500} rows={2} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </Field>
      {kind === "ticked" && errors.source && <Alert tone="error">{t("common", errors.source)}</Alert>}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      <MoveSheetActions startLabel={t("common", K.start)} closeLabel={t("common", K.close)} busy={starting.busy} disabled={!count} onStart={() => void start()} onCancel={onCancel} />
    </div>
  );
}

/**
 * "Retry the failed" on an ended job: billing counts what is still left of the
 * job's own selection, the admin confirms that number, and a new job starts
 * with the same reason. Each confirmed press is its own `requestId`.
 */
function RetryFailed({
  api,
  job,
  panelName,
  message,
  onStarted,
}: {
  api: ConfigMoveJobsApi;
  job: ConfigMoveJob;
  panelName: string;
  message: (e: unknown) => string;
  onStarted: (job: ConfigMoveJob) => void;
}) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ empty: true } | { error: unknown } | null>(null);
  const left = retrySelection(job);
  if (!left) return null;

  const retry = async () => {
    setBusy(true);
    setNote(null);
    try {
      const count = await api.count(left);
      if (count === 0) return setNote({ empty: true });
      if (!(await confirm({ title: t("common", K.retryConfirm, { count: String(count), panel: panelName }), confirmLabel: t("common", K.retry) }))) return;
      onStarted(await api.start({ ...left, requestId: crypto.randomUUID(), reason: job.reason }));
    } catch (e) {
      setNote({ error: e });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" size="sm" loading={busy} onClick={() => void retry()} className="self-start">
        {t("common", K.retry)}
      </Button>
      {note && "empty" in note && <Alert tone="info">{t("common", K.retryEmpty)}</Alert>}
      {note && "error" in note && <Alert tone="error">{message(note.error)}</Alert>}
    </div>
  );
}
