"use client";

import { useState } from "react";
import { Check, UsersRound } from "lucide-react";
import { audienceChanged } from "../_lib/audience";
import { useAudienceGroups } from "../_hooks/useAudienceGroups";
import { AudiencePicker } from "./AudiencePicker";
import { Button } from "./kit";

export type AudienceSectionProps = {
  /** The tenant whose groups are offered: `null` the session's, or a reseller by its path. */
  tenantId: string | null;
  /** The ids the record holds now; `[]` is every user. */
  saved: readonly string[];
  /** Saves the whole set on the feature's own route, answering what it holds after. */
  save: (ids: string[]) => Promise<string[]>;
  onSaved: (ids: string[]) => void;
  /** The sentence for a refused save, in the feature's words. */
  errorMessage: (e: unknown) => string;
  /** The feature's title, subtitle, save and saved texts, already translated. */
  text: { title: string; subtitle: string; save: string; saved: string };
  /** The section's anchor, for an editor's in-page navigation. */
  anchorId?: string;
};

/**
 * Who a record is offered to — a gateway (F-102-g-e) or a product (PT-1-b) — as
 * a section with its own save: billing replaces the set whole on its own route,
 * so it is never mixed into the form's "what changed". The picker is the shared
 * one (GR-1-x): every user, or users in any of the chosen groups.
 */
export function AudienceSection({ tenantId, saved: initial, save, onSaved, errorMessage, text, anchorId }: AudienceSectionProps) {
  const groups = useAudienceGroups(tenantId);
  const [saved, setSaved] = useState<string[]>([...initial]);
  const [selected, setSelected] = useState<string[]>([...initial]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const dirty = audienceChanged(saved, selected);

  const submit = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const ids = await save(selected);
      setSaved(ids);
      setSelected(ids);
      setDone(true);
      onSaved(ids);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id={anchorId} className="flex scroll-mt-4 flex-col gap-3 rounded-2xl border border-card-border bg-card-bg p-4 sm:p-5">
      <header className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-leaf-bg text-primary">
          <UsersRound size={18} aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-text-primary">{text.title}</h3>
          <p className="text-2xs leading-5 text-text-secondary">{text.subtitle}</p>
        </div>
      </header>

      <AudiencePicker
        multiple
        groups={groups}
        value={selected}
        onChange={(ids) => {
          setSelected(ids);
          setDone(false);
          setFailure(null);
        }}
      />

      <div className="flex flex-wrap items-center justify-end gap-3">
        {failure && (
          <p role="alert" className="me-auto text-xs font-bold text-error">
            {failure}
          </p>
        )}
        {done && !dirty && (
          <p role="status" className="me-auto inline-flex items-center gap-1 text-xs font-bold text-success">
            <Check size={14} aria-hidden />
            {text.saved}
          </p>
        )}
        <Button variant="primary" size="sm" disabled={!dirty || saving} loading={saving} onClick={() => void submit()}>
          {text.save}
        </Button>
      </div>
    </section>
  );
}
