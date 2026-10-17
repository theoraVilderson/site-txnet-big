"use client";

import { useEffect, useState, type ComponentProps } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { GroupMoveCount, GroupMoveJob, GroupMoveSource, GroupMovesApi, GroupMoveTarget } from "@/lib/billing-api";
import { GROUP_MOVE_KEYS as K, groupMoveRefusal, groupMoveTargets, normalSource, validateGroupMove, type GroupMoveForm } from "../../_lib/group-move";
import { Alert, Button, Dialog, Field, NativeSelect, Textarea, useConfirm } from "../kit";
import { GroupMoveJobCard } from "./GroupMoveJobCard";

/**
 * "Move to another group" (F-027-ev -> billing F-027-et, ADR-0127 decision 5):
 * the Grants ticked, or every Grant of one group, to another panel group.
 *
 *  - **the preview is billing's count**, for the target picked: how many
 *    Grants, how many configs keep their link and how many get a new one;
 *  - **one sheet, one `requestId`**: a double click starts one job;
 *  - **the job is shown live** (`GroupMoveJobCard`), and closing the sheet
 *    never stops it.
 *
 * Who may move what, and into which group, is the door's (`api`) — the owner's
 * on `/systems`, a reseller's on its users page; this sheet never asks.
 */
export function GroupMoveDialog({
  open,
  onClose,
  api,
  source,
  sourceLabel,
  nameOf = (grantId) => grantId.slice(0, 8),
  message,
  onEnded,
}: {
  open: boolean;
  onClose: () => void;
  api: GroupMovesApi;
  source: GroupMoveSource;
  /** What is being moved, in words: the ticked count, or the group's name. */
  sourceLabel: string;
  nameOf?: (grantId: string) => string;
  /** The page's own sentence for an error that is not a move's. */
  message: (e: unknown) => string;
  onEnded?: () => void;
}) {
  const { t } = useLocale();
  const [job, setJob] = useState<GroupMoveJob | null>(null);
  const say = (e: unknown) => {
    const key = groupMoveRefusal((e as { reason?: unknown } | null)?.reason);
    return key ? t("common", key) : message(e);
  };
  const close = () => {
    setJob(null);
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title={t("common", K.title)} description={sourceLabel} size="md">
      {job ? (
        <GroupMoveJobCard api={api} start={job} nameOf={nameOf} message={say} onEnded={onEnded} />
      ) : (
        <MoveForm api={api} source={source} message={say} onStarted={setJob} onCancel={close} />
      )}
    </Dialog>
  );
}

/** The entry point on a page: the button and its sheet, which owns whether it is open. */
export function GroupMoveButton({ disabled, ...sheet }: Omit<ComponentProps<typeof GroupMoveDialog>, "open" | "onClose"> & { disabled?: boolean }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" disabled={disabled} onClick={() => setOpen(true)}>
        {t("common", K.open)}
      </Button>
      {open && <GroupMoveDialog {...sheet} open onClose={() => setOpen(false)} />}
    </>
  );
}

/** The target, billing's preview for it, a reason, and the start behind a confirm. */
function MoveForm({
  api,
  source,
  message,
  onStarted,
  onCancel,
}: {
  api: GroupMovesApi;
  source: GroupMoveSource;
  message: (e: unknown) => string;
  onStarted: (job: GroupMoveJob) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const [targets, setTargets] = useState<GroupMoveTarget[] | null>(null);
  const [form, setForm] = useState<GroupMoveForm>({ toGroupId: "", reason: "" });
  // The count answered for one target: a stale one never reads as the current pick's.
  const [counted, setCounted] = useState<{ toGroupId: string; count: GroupMoveCount } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const sourceJson = JSON.stringify(normalSource(source));

  useEffect(() => {
    let alive = true;
    api.targets().then(
      (list) => alive && setTargets(groupMoveTargets(list, JSON.parse(sourceJson))),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [api, sourceJson]);

  useEffect(() => {
    if (!form.toGroupId) return;
    let alive = true;
    api.count({ source: JSON.parse(sourceJson), toGroupId: form.toGroupId }).then(
      (count) => alive && setCounted({ toGroupId: form.toGroupId, count }),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [api, sourceJson, form.toGroupId]);

  const count = counted && counted.toGroupId === form.toGroupId ? counted.count : null;
  const target = targets?.find((g) => g.id === form.toGroupId);

  async function start() {
    const checked = validateGroupMove(form, source, requestId);
    if (!checked.ok) return setErrors(checked.errors);
    setErrors({});
    if (!count || !target) return;
    const asked = t("common", K.confirm, { grants: String(count.grants), group: target.name, move: String(count.move) });
    if (!(await confirm({ title: asked, confirmLabel: t("common", K.start) }))) return;
    setBusy(true);
    setError(null);
    try {
      onStarted(await api.start(checked.body));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-5 text-text-secondary">{t("common", K.intro)}</p>
      {targets === null ? (
        error === null && <p className="text-xs text-text-secondary">{t("common", K.loading)}</p>
      ) : targets.length === 0 ? (
        <Alert tone="info">{t("common", K.noTargets)}</Alert>
      ) : (
        <Field label={t("common", K.target)} error={errors.toGroupId && t("common", errors.toGroupId)}>
          <NativeSelect value={form.toGroupId} onChange={(e) => setForm({ ...form, toGroupId: e.target.value })}>
            <option value="">{t("common", K.targetPick)}</option>
            {targets.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      )}
      {form.toGroupId && (
        <p className="text-xs font-bold text-text-primary" role="status">
          {count === null
            ? t("common", K.counting)
            : count.grants === 0
              ? t("common", K.previewEmpty)
              : t("common", K.preview, { grants: String(count.grants), keep: String(count.keep), move: String(count.move) })}
        </p>
      )}
      <Field label={t("common", K.reason)} error={errors.reason && t("common", errors.reason)}>
        <Textarea value={form.reason} maxLength={500} rows={2} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </Field>
      {errors.source && <Alert tone="error">{t("common", errors.source)}</Alert>}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" loading={busy} disabled={!count || count.grants === 0} onClick={() => void start()}>
          {t("common", K.start)}
        </Button>
        <Button variant="quiet" size="sm" onClick={onCancel}>
          {t("common", K.close)}
        </Button>
      </div>
    </div>
  );
}
