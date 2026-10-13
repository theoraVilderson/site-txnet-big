"use client";

import { Check } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "./cn";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * An on/off switch drawn as a whole row — label, hint, the track at the end
 * (UX-1-c, `contract.ux.md` K5). Moved here unchanged from
 * `gateways/_components/gateway-fields.tsx`, where five forms already used it.
 */
export function Toggle({ checked, onChange, label, hint, disabled, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-2xl border border-card-border bg-[var(--bg-inner)] p-3 text-start transition-colors hover:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-bold text-text-primary">{label}</span>
        {hint && <span className="text-2xs text-text-secondary">{hint}</span>}
      </span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-primary" : "bg-[var(--leaf-bg)] ring-1 ring-inset ring-card-border"}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "start-[1.375rem]" : "start-0.5"}`} />
      </span>
    </button>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * A native checkbox under a drawn box, so the keyboard, the form and assistive
 * technology get the real control and only the look is ours.
 */
export function Checkbox({ checked, onChange, label, hint, disabled, className }: CheckboxProps) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn("inline-flex cursor-pointer items-start gap-2.5 text-sm", disabled && "cursor-not-allowed opacity-60", className)}>
      <span className="relative mt-0.5 grid size-5 shrink-0 place-items-center">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="peer absolute inset-0 m-0 cursor-[inherit] appearance-none rounded-md border border-card-border bg-bg-inner transition-colors checked:border-primary checked:bg-primary hover:border-primary"
        />
        <Check size={14} strokeWidth={3} aria-hidden className="pointer-events-none relative text-on-accent opacity-0 transition-opacity peer-checked:opacity-100" />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-text-primary">{label}</span>
        {hint && (
          <span id={`${id}-hint`} className="text-xs text-text-secondary">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
