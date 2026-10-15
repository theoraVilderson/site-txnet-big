"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type DriftResolution, type SystemsDriftEvent } from "@/lib/billing-api";
import { useLiveReread } from "@/hooks/useLiveReread";
import { formatInstant } from "../../_lib/datetime";
import {
  DRIFT_EVENTS,
  RESOLUTION_KEYS,
  acknowledgeBodyOf,
  addressMoveOf,
  canAcknowledge,
  driftStoryOf,
  haltsCollection,
  resolutionsOf,
} from "../_lib/drift-resolution";
import { DRIFT_EVENT_KEYS, SYSTEMS_KEYS as K } from "../_lib/systems";
import { ListState, NoteForm, Section, StateFilter, useSystemsError } from "./parts";
import { useCursorList } from "./useCursorList";
import { Button, RadioCards } from "../../_components/kit";

const FILTERS = [
  { id: "open", label: K.filter.open },
  { id: "all", label: K.filter.all },
] as const;

const fetchDrift = (q: { state: "open" | "all"; after?: string }) => billingApi.driftEvents(q);

/**
 * The drift report (F-027-as's routes). An event that halts collection waits
 * for a person; acknowledging it — once — resumes collection on the next pass
 * (billing `contract.systems.md` rules 8–9). A new halting event arrives
 * without a reload (F-027-fh): `channel` is the page's (`liveChannelOf`).
 */
export function DriftReport({ channel, onAcknowledged }: { channel: string | null; onAcknowledged: () => Promise<void> }) {
  const { t } = useLocale();
  const list = useCursorList<SystemsDriftEvent, "open" | "all">(fetchDrift, "open");
  useLiveReread(channel, DRIFT_EVENTS, () => void list.reload());

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
          <Button variant="quiet" size="sm" onClick={() => void list.more()} className="self-center text-primary hover:text-primary">
            {t("common", K.more)}
          </Button>
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
  const [resolution, setResolution] = useState<DriftResolution | null>(null);
  const story = driftStoryOf(event);
  const move = addressMoveOf(event);
  const choices = resolutionsOf(event);
  // A move is acknowledged by trusting the new address (billing rule 9b); every other event is acknowledged as it is.
  const submitLabel = move ? K.drift.trustAddress : K.drift.submit;

  const acknowledge = async (note: string | undefined) => {
    const checked = acknowledgeBodyOf(event, note, resolution);
    if (!checked.ok) {
      setFailure(t("common", checked.error));
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await billingApi.acknowledgeDrift(event.id, checked.body);
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
              <span className="inline-flex items-center gap-1 rounded-full border border-error-border bg-error-bg px-2 py-0.5 text-3xs font-bold text-error">
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
          {event.foreignPanel && (
            <span className="text-text-primary">{t("common", K.drift.foreignPanel, { name: event.foreignPanel.name })}</span>
          )}
          {event.eventType === "foreign_claim" && haltsCollection(event) && (
            <span className="text-text-secondary">{t("common", K.drift.foreignHint)}</span>
          )}
          {story && <span className="leading-5 text-text-primary">{t("common", story)}</span>}
          {move && <AddressMove known={move.known} seen={move.seen} />}
          {event.note && <span className="text-text-secondary">{event.note}</span>}
        </div>
        {canAcknowledge(event) && !formOpen && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => setFormOpen(true)}
          >
            {t("common", move ? K.drift.trustAddress : K.drift.acknowledge)}
          </Button>
        )}
      </div>
      {failure && (
        <p role="alert" className="font-bold text-error">
          {failure}
        </p>
      )}
      {formOpen && canAcknowledge(event) && (
        <NoteForm
          title={t("common", move ? K.drift.trustAddress : K.drift.acknowledge)}
          hint={t("common", move ? K.drift.trustHint : K.drift.acknowledgeHint)}
          submitLabel={t("common", submitLabel)}
          required={false}
          busy={busy}
          onSubmit={(note) => void acknowledge(note)}
          onCancel={() => setFormOpen(false)}
        >
          {choices.length > 0 && (
            <RadioCards<DriftResolution | "">
              value={resolution ?? ""}
              onChange={(v) => setResolution(v === "" ? null : v)}
              ariaLabel={t("common", K.drift.resolutionTitle)}
              options={choices.map((c) => ({ value: c, label: t("common", RESOLUTION_KEYS[c].label), description: t("common", RESOLUTION_KEYS[c].hint) }))}
            />
          )}
        </NoteForm>
      )}
    </li>
  );
}

/** An `address_moved`'s two lists (F-027-fb): what the panel was accepted at, and where its name points now. */
function AddressMove({ known, seen }: { known: string[]; seen: string[] }) {
  const { t } = useLocale();
  return (
    <span className="flex flex-col gap-0.5 text-text-secondary">
      <span>
        {t("common", K.drift.knownAddresses)}: <span dir="ltr" className="font-mono">{known.join(", ") || "—"}</span>
      </span>
      <span>
        {t("common", K.drift.seenAddresses)}: <span dir="ltr" className="font-mono text-error">{seen.join(", ") || "—"}</span>
      </span>
    </span>
  );
}
