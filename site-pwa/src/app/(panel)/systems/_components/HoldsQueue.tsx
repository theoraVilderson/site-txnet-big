"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type SystemsHold } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { formatBytes } from "../../services/_lib/service-configs";
import { HOLD_REASON_KEYS, HOLD_STATE_KEYS, SYSTEMS_KEYS as K, canResolveHold } from "../_lib/systems";
import { ListState, NoteForm, Section, StateFilter, useSystemsError } from "./parts";
import { useCursorList } from "./useCursorList";

const FILTERS = [
  { id: "pending", label: K.filter.pending },
  { id: "all", label: K.filter.all },
] as const;

const fetchHolds = (q: { state: "pending" | "all"; after?: string }) => billingApi.usageHolds(q);

/**
 * The holds queue (F-027-at's routes) — the visible face of *in doubt, do not
 * charge*. A release is queued for the meter and the hold reads `pending`
 * until it is billed; a write-off is never charged and needs a note
 * (billing `contract.systems.md` rules 10–13).
 */
export function HoldsQueue() {
  const { t } = useLocale();
  const list = useCursorList<SystemsHold, "pending" | "all">(fetchHolds, "pending");

  return (
    <Section
      title={t("common", K.holds.title)}
      hint={t("common", K.holds.hint)}
      actions={<StateFilter value={list.state} options={FILTERS} onChange={list.setState} />}
    >
      <ListState isLoading={list.isLoading} error={list.error} empty={list.rows.length === 0 ? K.holds.empty : null} onRetry={() => void list.reload()}>
        <ul className="divide-y divide-card-border">
          {list.rows.map((h) => (
            <HoldItem key={h.id} hold={h} onDecided={list.reload} />
          ))}
        </ul>
        {list.next && (
          <button type="button" onClick={() => void list.more()} className="self-center text-xs font-bold text-primary">
            {t("common", K.more)}
          </button>
        )}
      </ListState>
    </Section>
  );
}

function HoldItem({ hold, onDecided }: { hold: SystemsHold; onDecided: () => Promise<void> }) {
  const { lang, t } = useLocale();
  const message = useSystemsError();
  const [form, setForm] = useState<"release" | "writeOff" | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A release answers 202 and the hold stays pending until the meter bills it.
  const [queued, setQueued] = useState(false);

  const run = async (call: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    setFailure(null);
    try {
      await call();
      setForm(null);
      after();
      await onDecided();
    } catch (e) {
      setFailure(message(e));
      await onDecided();
    } finally {
      setBusy(false);
    }
  };

  const decided = hold.state !== "pending";

  return (
    <li className="flex flex-col gap-2 py-4 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
            {t("common", HOLD_REASON_KEYS[hold.reason])}
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                decided ? "border-card-border bg-bg-inner text-text-secondary" : "border-primary/20 bg-leaf-bg text-primary"
              }`}
            >
              {t("common", HOLD_STATE_KEYS[hold.state])}
            </span>
          </span>
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-text-secondary">
            <span className="font-bold text-text-primary">{hold.panelName}</span>
            <span dir="ltr">
              {t("common", K.holds.bytes, { up: formatBytes(hold.upBytes, lang) ?? hold.upBytes, down: formatBytes(hold.downBytes, lang) ?? hold.downBytes })}
            </span>
            <span>
              {t("common", K.holds.heldFrom)}: <span dir="ltr">{formatInstant(hold.heldFrom, lang)}</span>
            </span>
            {hold.resolvedAt && (
              <span>
                {t("common", K.holds.resolvedAt)}: <span dir="ltr">{formatInstant(hold.resolvedAt, lang)}</span>
              </span>
            )}
          </span>
          <span dir="ltr" className="font-mono text-[10px] text-text-secondary">
            {hold.configId}
          </span>
          {hold.resolutionNote && <span className="text-text-secondary">{hold.resolutionNote}</span>}
        </div>
        {canResolveHold(hold) && form === null && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setForm("release")}
              className="rounded-xl bg-primary px-3 py-2 text-xs font-bold text-text-on-accent disabled:opacity-50"
            >
              {t("common", K.holds.release)}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setForm("writeOff")}
              className="rounded-xl border border-error-border px-3 py-2 text-xs font-bold text-error hover:bg-error-bg disabled:opacity-50"
            >
              {t("common", K.holds.writeOff)}
            </button>
          </div>
        )}
      </div>
      {queued && hold.state === "pending" && (
        <p role="status" className="font-bold text-primary">
          {t("common", K.holds.queued)}
        </p>
      )}
      {failure && (
        <p role="alert" className="font-bold text-error">
          {failure}
        </p>
      )}
      {form === "release" && canResolveHold(hold) && (
        <NoteForm
          title={t("common", K.holds.release)}
          hint={t("common", K.holds.releaseHint)}
          submitLabel={t("common", K.holds.releaseSubmit)}
          required={false}
          busy={busy}
          onSubmit={(note) => void run(() => billingApi.releaseHold(hold.id, note), () => setQueued(true))}
          onCancel={() => setForm(null)}
        />
      )}
      {form === "writeOff" && canResolveHold(hold) && (
        <NoteForm
          title={t("common", K.holds.writeOff)}
          hint={t("common", K.holds.writeOffHint)}
          submitLabel={t("common", K.holds.writeOffSubmit)}
          required
          tone="error"
          busy={busy}
          onSubmit={(note) => void run(() => billingApi.writeOffHold(hold.id, note!), () => undefined)}
          onCancel={() => setForm(null)}
        />
      )}
    </li>
  );
}
