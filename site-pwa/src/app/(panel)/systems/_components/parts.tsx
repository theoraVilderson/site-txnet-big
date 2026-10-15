"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { Loader2, MoreHorizontal, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { SYSTEMS_KEYS as K, refusalSentence, validateNote, type HolderNames } from "../_lib/systems";
import { Button, Field, IconButton, Menu, SegmentedControl, Textarea } from "../../_components/kit";

const NO_NAMES: HolderNames = { panel: () => null, group: () => null };

/** The panels and groups the page read, so a refusal can name the one holding what was refused (F-027-ci). */
export const HolderNamesContext = createContext<HolderNames>(NO_NAMES);

/** A refusal billing named in this page's words, naming its holder where the page can; anything else in the client's. */
export function useSystemsError(): (e: unknown) => string {
  const { t } = useLocale();
  const names = useContext(HolderNamesContext);
  const errorMessage = useApiErrorMessage();
  return (e) => {
    const sentence = refusalSentence(e, names);
    return sentence ? t("common", sentence.key, sentence.vars) : errorMessage(e);
  };
}

/** Theme tokens only: green for what is well, error tones for what stopped, never gold. */
export const GOOD = "border-primary/20 bg-leaf-bg text-primary";
export const BAD = "border-error-border bg-error-bg text-error";
export const QUIET = "border-card-border bg-bg-inner text-text-secondary";

export const REVIEW_TONE = { pending: QUIET, accepted: GOOD, accepted_low_trust: QUIET, refused: BAD } as const;
export const STATE_TONE = { healthy: GOOD, degraded: QUIET, maintenance: QUIET, down: BAD, throttled_or_blocked: BAD } as const;

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-3xs font-bold ${tone}`}>{children}</span>;
}

export function Section({ title, hint, actions, children }: { title: string; hint?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-text-primary">{title}</h2>
          {hint && <p className="mt-1 text-xs leading-5 text-text-secondary">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A card's button — the kit `Button` (K3), green tokens, never gold. `tone: "error"` for the one that gives something up. */
export function CardButton({
  icon,
  children,
  onClick,
  pressed,
  tone = "plain",
  disabled,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  pressed?: boolean;
  tone?: "plain" | "error";
  disabled?: boolean;
}) {
  return (
    <Button
      size="sm"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      icon={icon}
      className={tone === "error" ? "border-error-border text-error hover:border-error hover:bg-error-bg hover:text-error" : pressed ? "border-primary/30 bg-leaf-bg text-primary" : undefined}
    >
      {children}
    </Button>
  );
}

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; tone?: "error" };

/**
 * The rarer actions of a card, behind one button, so a row stays readable on
 * a phone: the kit `Menu` (K7) — arrows, Esc and Tab, focus back to the button.
 */
export function ActionsMenu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  if (items.length === 0) return null;
  return (
    <Menu
      label={label}
      trigger={<IconButton variant="secondary" size="sm" aria-label={label} title={label} icon={<MoreHorizontal size={16} aria-hidden />} />}
      items={items.map((item) => ({ id: item.label, label: item.label, icon: item.icon, onSelect: item.onSelect, tone: item.tone === "error" ? "danger" : "default" }))}
    />
  );
}

/** A sentence after an action: green when it landed, error tones when it was refused. */
export function Notice({ tone, children }: { tone: "good" | "bad"; children: ReactNode }) {
  return (
    <p role={tone === "bad" ? "alert" : "status"} className={`rounded-xl border px-3 py-2 text-xs font-bold leading-5 ${tone === "bad" ? BAD : GOOD}`}>
      {children}
    </p>
  );
}

/** Loading, error-with-retry, empty, or the list — every list on this page reads the same way. */
export function ListState({
  isLoading,
  error,
  empty,
  onRetry,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  /** The sentence to show when there is nothing; null when there is something. */
  empty: string | null;
  onRetry: () => void;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const message = useSystemsError();
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-text-secondary">
        <Loader2 size={14} className="animate-spin" aria-hidden />
        {t("common", K.loading)}
      </p>
    );
  }
  if (error) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="alert" className="text-xs font-bold text-error">
          {message(error)}
        </p>
        <Button variant="quiet" size="sm" onClick={onRetry} icon={<RotateCw size={14} aria-hidden />} className="text-primary hover:text-primary">
          {t("common", K.retry)}
        </Button>
      </div>
    );
  }
  if (empty !== null) return <p className="py-4 text-center text-sm text-text-secondary">{t("common", empty)}</p>;
  return <>{children}</>;
}

/** Two or three choices over a list's `state` query: the kit `SegmentedControl` (K5). Green tokens only — never gold on a control. */
export function StateFilter<S extends string>({ value, options, onChange }: { value: S; options: readonly { id: S; label: string }[]; onChange: (s: S) => void }) {
  const { t } = useLocale();
  return (
    <SegmentedControl<S>
      ariaLabel={t("common", K.filter.label)}
      size="sm"
      value={value}
      onChange={onChange}
      options={options.map((o) => ({ value: o.id, label: t("common", o.label) }))}
    />
  );
}

/**
 * The note an acknowledge, a release or a write-off carries (1–1000, trimmed).
 * `tone: "error"` for the one that gives something up — a write-off.
 */
export function NoteForm({
  title,
  hint,
  submitLabel,
  required,
  tone = "primary",
  busy,
  onSubmit,
  onCancel,
  children,
}: {
  title: string;
  hint: string;
  submitLabel: string;
  required: boolean;
  tone?: "primary" | "error";
  busy: boolean;
  onSubmit: (note: string | undefined) => void;
  onCancel: () => void;
  /** A choice the decision takes beside its note (F-027-fb), above the note. */
  children?: ReactNode;
}) {
  const { t } = useLocale();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const checked = validateNote(note, { required });
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    onSubmit(checked.note);
  };

  return (
    <form
      onSubmit={submit}
      className={`flex flex-col gap-3 rounded-2xl border bg-bg-inner p-4 ${tone === "error" ? "border-error-border" : "border-card-border"}`}
    >
      <p className={`text-sm font-bold ${tone === "error" ? "text-error" : "text-text-primary"}`}>{title}</p>
      <p className="text-xs leading-5 text-text-secondary">{hint}</p>
      {children}
      <Field label={t("common", K.note.label)} error={error ? t("common", error) : undefined}>
        <Textarea
          value={note}
          maxLength={1000}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant={tone === "error" ? "danger" : "primary"} loading={busy}>
          {submitLabel}
        </Button>
        <Button variant="quiet" size="sm" onClick={onCancel}>
          {t("common", K.holds.cancel)}
        </Button>
      </div>
    </form>
  );
}
