"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, MoreHorizontal, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { SYSTEMS_KEYS as K, refusalKey, validateNote } from "../_lib/systems";

/** A refusal billing named in this page's words; anything else in the client's. */
export function useSystemsError(): (e: unknown) => string {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

/** Theme tokens only: green for what is well, error tones for what stopped, never gold. */
export const GOOD = "border-primary/20 bg-leaf-bg text-primary";
export const BAD = "border-error-border bg-error-bg text-error";
export const QUIET = "border-card-border bg-bg-inner text-text-secondary";

export const REVIEW_TONE = { pending: QUIET, accepted: GOOD, accepted_low_trust: QUIET, refused: BAD } as const;
export const STATE_TONE = { healthy: GOOD, degraded: QUIET, maintenance: QUIET, down: BAD, throttled_or_blocked: BAD } as const;

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}>{children}</span>;
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

/** A card's button — green tokens, never gold (panel theme). `tone: "error"` for the one that gives something up. */
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
  const look =
    tone === "error"
      ? "border-error-border text-error hover:bg-error-bg"
      : pressed
        ? "border-primary/30 bg-leaf-bg text-primary"
        : "border-card-border text-text-primary hover:bg-leaf-bg";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-bold disabled:opacity-50 ${look}`}
    >
      {icon}
      {children}
    </button>
  );
}

export type MenuItem = { label: string; icon?: ReactNode; onSelect: () => void; tone?: "error" };

/**
 * The rarer actions of a card, behind one button, so a row stays readable on
 * a phone. Closes on a pick, on Escape and on a click outside; the items are
 * real buttons, so the keyboard reaches them in order.
 */
export function ActionsMenu({ label, items }: { label: string; items: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (items.length === 0) return null;
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="inline-flex items-center rounded-xl border border-card-border p-2 text-text-secondary hover:bg-leaf-bg hover:text-text-primary"
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute end-0 top-full z-20 mt-1 flex min-w-48 flex-col rounded-2xl border border-card-border bg-card-bg p-1 shadow-lg">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`flex items-center gap-2 rounded-xl px-3 py-2 text-start text-xs font-bold ${
                item.tone === "error" ? "text-error hover:bg-error-bg" : "text-text-primary hover:bg-leaf-bg"
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
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
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 text-xs font-bold text-primary">
          <RotateCw size={14} aria-hidden />
          {t("common", K.retry)}
        </button>
      </div>
    );
  }
  if (empty !== null) return <p className="py-4 text-center text-sm text-text-secondary">{t("common", empty)}</p>;
  return <>{children}</>;
}

/** Two or three tabs over a list's `state` query. Green tokens only — never gold on a control. */
export function StateFilter<S extends string>({ value, options, onChange }: { value: S; options: readonly { id: S; label: string }[]; onChange: (s: S) => void }) {
  const { t } = useLocale();
  return (
    <div role="tablist" className="inline-flex rounded-xl border border-card-border p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-lg px-3 py-1 text-xs font-bold ${value === o.id ? "bg-primary text-text-on-accent" : "text-text-secondary hover:bg-leaf-bg"}`}
        >
          {t("common", o.label)}
        </button>
      ))}
    </div>
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
}: {
  title: string;
  hint: string;
  submitLabel: string;
  required: boolean;
  tone?: "primary" | "error";
  busy: boolean;
  onSubmit: (note: string | undefined) => void;
  onCancel: () => void;
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
      <label className="flex flex-col gap-1 text-xs text-text-secondary">
        {t("common", K.note.label)}
        <textarea
          value={note}
          maxLength={1000}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          className="rounded-xl border border-card-border bg-card-bg px-3 py-2 text-sm text-text-primary"
        />
        {error && <span className="text-error">{t("common", error)}</span>}
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy}
          className={
            tone === "error"
              ? "rounded-xl border border-error-border bg-error-bg px-4 py-2 text-xs font-bold text-error disabled:opacity-50"
              : "rounded-xl bg-primary px-4 py-2 text-xs font-bold text-text-on-accent disabled:opacity-50"
          }
        >
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="rounded-xl px-4 py-2 text-xs font-medium text-text-secondary hover:bg-leaf-bg">
          {t("common", K.holds.cancel)}
        </button>
      </div>
    </form>
  );
}
