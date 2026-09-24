"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type SystemsDriftEvent } from "@/lib/billing-api";
import { formatInstant } from "../../_lib/datetime";
import { DRIFT_EVENT_KEYS, SYSTEMS_KEYS as K, canAcknowledge, haltsCollection } from "../_lib/systems";
import { ListState, NoteForm, Section, StateFilter, useSystemsError } from "./parts";
import { useCursorList } from "./useCursorList";

const FILTERS = [
  { id: "open", label: K.filter.open },
  { id: "all", label: K.filter.all },
] as const;

const fetchDrift = (q: { state: "open" | "all"; after?: string }) => billingApi.driftEvents(q);

/**
 * The drift report (F-027-as's routes). An event that halts collection waits
 * for a person; acknowledging it — once — resumes collection on the next pass
 * (billing `contract.systems.md` rules 8–9).
 */
export function DriftReport({ onAcknowledged }: { onAcknowledged: () => Promise<void> }) {
  const { t } = useLocale();
  const list = useCursorList<SystemsDriftEvent, "open" | "all">(fetchDrift, "open");

  const acknowledged = async () => {
    await Promise.all([list.reload(), onAcknowledged()]);
  };

  return (
    <Section
      title={t("common", K.drift.title)}
      hint={t("common", K.drift.hint)}
      actions={<StateFilter value={list.state} options={FILTERS} onChange={list.setState} />}
    >
      <ListState isLoading={list.isLoading} error={list.error} empty={list.rows.length === 0 ? K.drift.empty : null} onRetry={() => void list.reload()}>
        <ul className="divide-y divide-card-border">
          {list.rows.map((e) => (
            <DriftItem key={e.id} event={e} onAcknowledged={acknowledged} />
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

function DriftItem({ event, onAcknowledged }: { event: SystemsDriftEvent; onAcknowledged: () => Promise<void> }) {
  const { lang, t } = useLocale();
  const message = useSystemsError();
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const acknowledge = async (note: string | undefined) => {
    setBusy(true);
    setFailure(null);
    try {
      await billingApi.acknowledgeDrift(event.id, note);
      setFormOpen(false);
      await onAcknowledged();
    } catch (e) {
      setFailure(message(e));
      // A 409 means someone else decided: read again to show who.
      await onAcknowledged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 py-4 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
            {t("common", DRIFT_EVENT_KEYS[event.eventType])}
            <span className="text-xs font-medium text-text-secondary">{event.panelName}</span>
            {haltsCollection(event) && (
              <span className="inline-flex items-center gap-1 rounded-full border border-error-border bg-error-bg px-2 py-0.5 text-[10px] font-bold text-error">
                <TriangleAlert size={10} aria-hidden />
                {t("common", K.panels.halted)}
              </span>
            )}
          </span>
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-text-secondary">
            <span>
              {t("common", K.drift.affected, {
                affected: String(event.affectedConfigCount),
                observed: String(event.observedConfigCount),
              })}
            </span>
            <span>
              {t("common", K.drift.detectedAt)}: <span dir="ltr">{formatInstant(event.detectedAt, lang)}</span>
            </span>
            {event.acknowledgedAt && (
              <span>
                {t("common", K.drift.acknowledgedAt)}: <span dir="ltr">{formatInstant(event.acknowledgedAt, lang)}</span>
              </span>
            )}
          </span>
          {event.note && <span className="text-text-secondary">{event.note}</span>}
        </div>
        {canAcknowledge(event) && !formOpen && (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="rounded-xl bg-primary px-3 py-2 text-xs font-bold text-text-on-accent"
          >
            {t("common", K.drift.acknowledge)}
          </button>
        )}
      </div>
      {failure && (
        <p role="alert" className="font-bold text-error">
          {failure}
        </p>
      )}
      {formOpen && canAcknowledge(event) && (
        <NoteForm
          title={t("common", K.drift.acknowledge)}
          hint={t("common", K.drift.acknowledgeHint)}
          submitLabel={t("common", K.drift.submit)}
          required={false}
          busy={busy}
          onSubmit={(note) => void acknowledge(note)}
          onCancel={() => setFormOpen(false)}
        />
      )}
    </li>
  );
}
