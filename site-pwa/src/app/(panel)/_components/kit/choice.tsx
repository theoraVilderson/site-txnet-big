"use client";

import { motion } from "framer-motion";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { DURATION, EASE } from "@/lib/motion";
import { cn } from "./cn";

export interface ChoiceOption<V extends string> {
  value: V;
  label: ReactNode;
  /** RadioCards only: one line under the label. */
  description?: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
}

interface ChoiceProps<V extends string> {
  value: V;
  onChange: (value: V) => void;
  options: readonly ChoiceOption<V>[];
  /** The group's accessible name. */
  ariaLabel: string;
  className?: string;
}

/**
 * A radio group's keyboard (WAI-ARIA radio pattern): one tab stop — the chosen
 * option — and the arrows move the choice, skipping disabled options and
 * wrapping. Left/right follow the reading direction, so in Persian the right
 * arrow goes back.
 */
function useRoving<V extends string>(value: V, options: readonly ChoiceOption<V>[], onChange: (v: V) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const chosen = options.findIndex((o) => o.value === value);
  const tabStop = chosen >= 0 && !options[chosen].disabled ? chosen : (enabled[0] ?? -1);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = e.currentTarget.closest("[dir]")?.getAttribute("dir") === "rtl";
    const forward = ["ArrowDown", rtl ? "ArrowLeft" : "ArrowRight"];
    const back = ["ArrowUp", rtl ? "ArrowRight" : "ArrowLeft"];
    const step = forward.includes(e.key) ? 1 : back.includes(e.key) ? -1 : 0;
    if (step === 0 || enabled.length === 0) return;
    e.preventDefault();
    const at = Math.max(0, enabled.indexOf(index));
    const next = enabled[(at + step + enabled.length) % enabled.length];
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return { refs, tabStop, onKeyDown };
}

/**
 * Options as cards — an icon, a title, a line (UX-1-c, `contract.ux.md` K5);
 * what `gateway-fields`' `ChoiceCards` draws, as a kit primitive.
 */
export function RadioCards<V extends string>({ value, onChange, options, ariaLabel, columns = 2, className }: ChoiceProps<V> & { columns?: 1 | 2 | 3 }) {
  const { refs, tabStop, onKeyDown } = useRoving(value, options, onChange);
  const grid = columns === 1 ? "" : columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3";
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("grid gap-2", grid, className)}>
      {options.map((o, i) => {
        const selected = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={o.disabled}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "flex items-start gap-3 rounded-2xl border p-3 text-start transition-all disabled:cursor-not-allowed disabled:opacity-50",
              selected ? "border-primary bg-leaf-bg shadow-sm" : "border-card-border bg-bg-inner hover:border-primary",
            )}
          >
            {Icon && (
              <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl", selected ? "bg-primary text-on-accent" : "bg-card-bg text-primary")}>
                <Icon size={18} aria-hidden />
              </span>
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-bold text-text-primary">{o.label}</span>
              {o.description && <span className="text-xs text-text-secondary">{o.description}</span>}
            </span>
            <span
              aria-hidden
              className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-2", selected ? "border-primary" : "border-card-border")}
            >
              {selected && <span className="size-2 rounded-full bg-primary" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A few short options in one pill, the chosen one under a highlight that
 * slides between them (UX-1-c, `contract.ux.md` K5). The highlight is a shared
 * `layoutId`, scoped to this instance so two controls on a page never trade it;
 * at `reduced` the panel's `MotionConfig` turns the slide into a cut.
 */
export function SegmentedControl<V extends string>({ value, onChange, options, ariaLabel, size = "md", className }: ChoiceProps<V> & { size?: "sm" | "md" }) {
  const { refs, tabStop, onKeyDown } = useRoving(value, options, onChange);
  const layoutId = `segment-${useId()}`;
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("inline-flex items-center gap-1 rounded-xl border border-card-border bg-bg-inner p-1", className)}>
      {options.map((o, i) => {
        const selected = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={o.disabled}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "relative inline-flex items-center justify-center gap-1.5 rounded-lg font-bold transition-colors disabled:opacity-50",
              size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
              selected ? "text-on-accent" : "text-text-secondary hover:text-text-primary",
            )}
          >
            {selected && (
              <motion.span
                layoutId={layoutId}
                aria-hidden
                className="absolute inset-0 rounded-lg bg-primary shadow-sm"
                transition={{ duration: DURATION.base, ease: EASE.standard }}
              />
            )}
            {Icon && <Icon size={14} aria-hidden className="relative" />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
