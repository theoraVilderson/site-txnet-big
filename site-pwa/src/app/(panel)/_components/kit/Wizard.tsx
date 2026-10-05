"use client";

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Lightbulb, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import { Button, IconButton } from "./Button";
import { cn } from "./cn";
import { useConfirm } from "./confirm";
import { useOverlayLayer } from "./overlay";

const K = FrontendI18nKeys.common.kit;

export interface WizardStepMeta {
  id: string;
  title: ReactNode;
  /** One line under the title in the rail. */
  subtitle?: ReactNode;
  icon?: LucideIcon;
}

export interface WizardState {
  index: number;
  /** The furthest step reached; the rail opens every step up to it. */
  reached: number;
  /** 1 forward, -1 back — which way the next step slides in. */
  direction: 1 | -1;
  goTo: (index: number) => void;
  /** The current step's validation, then the step after it. False when it refused. */
  next: () => boolean;
  reset: () => void;
}

/**
 * Where a wizard is (UX-1-f). The host owns its form; this owns the step
 * index, the furthest step reached and the slide direction. `validate` is the
 * host's per-step check (K12: before Next); `onMove` runs on every move, the
 * place a host clears a failure that belonged to the step it left.
 */
export function useWizard({
  count,
  validate,
  onMove,
}: {
  count: number;
  validate?: (index: number) => boolean;
  onMove?: (to: number) => void;
}): WizardState {
  const [index, setIndex] = useState(0);
  const [reached, setReached] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);

  const goTo = (to: number) => {
    const clamped = Math.max(0, Math.min(count - 1, to));
    setDirection(clamped >= index ? 1 : -1);
    setIndex(clamped);
    setReached((r) => Math.max(r, clamped));
    onMove?.(clamped);
  };

  const next = () => {
    if (validate && !validate(index)) return false;
    goTo(index + 1);
    return true;
  };

  const reset = () => {
    setIndex(0);
    setReached(0);
    setDirection(1);
  };

  return { index, reached, direction, goTo, next, reset };
}

export interface WizardProps {
  /** The wizard's name: the rail's heading, and the title once `done`. */
  title: ReactNode;
  icon?: LucideIcon;
  steps: readonly WizardStepMeta[];
  wizard: WizardState;
  /** Something was entered: closing asks `closeQuestion` first (K9, `default`). */
  dirty?: boolean;
  closeQuestion: string;
  /** Saving: the rail and Back lock, the submit button spins (K3). */
  busy?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onClose: () => void;
  /** The finished screen. It replaces the steps and the footer; closing no longer asks. */
  done?: ReactNode;
  /** Above the step's own fields. */
  intro?: ReactNode;
  /** A hint box under them. */
  tip?: ReactNode;
  /** A refusal for the whole step, under everything. */
  error?: ReactNode;
  children: ReactNode;
}

/**
 * A step-by-step dialog (UX-1-f, `contract.ux.md` K12), extracted from
 * `GatewayWizard`: full screen below `sm`, a dialog above it, the step rail at
 * the start side from `lg` and a progress bar under the header at every width;
 * steps slide in the way they are walked. The host renders the current step
 * as `children` and decides what Next checks (`useWizard`'s `validate`).
 *
 * Esc, the X and Cancel are one close, and a dirty wizard asks before it.
 */
export function Wizard(props: WizardProps) {
  if (typeof document === "undefined") return null;
  return <WizardLayer {...props} />;
}

function WizardLayer({
  title,
  icon: TitleIcon,
  steps,
  wizard,
  dirty = false,
  closeQuestion,
  busy = false,
  submitLabel,
  onSubmit,
  onClose,
  done,
  intro,
  tip,
  error,
  children,
}: WizardProps) {
  const { t, isRtl } = useLocale();
  const level = useMotionLevel();
  const confirm = useConfirm();
  const present = useIsPresent();
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const reduced = level === "reduced";

  const finished = done !== undefined && done !== null && done !== false;
  const requestClose = async () => {
    if (dirty && !finished) {
      const leave = await confirm({ title: closeQuestion, confirmLabel: t("common", K.wizard.leave) });
      if (!leave) return;
    }
    onClose();
  };
  useOverlayLayer({ active: present, containerRef: panelRef, onClose: () => void requestClose() });

  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: 0 });
  }, [wizard.index]);

  const { index, reached, direction } = wizard;
  const step = steps[index];
  const total = steps.length;
  const last = index === total - 1;
  const StepIcon = step.icon;
  const slide = reduced ? { opacity: 0 } : { x: direction * (isRtl ? -24 : 24), opacity: 0 };
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const NextIcon = isRtl ? ArrowLeft : ArrowRight;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center sm:items-center sm:p-4">
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: DURATION.base, ease: EASE.exit } }}
        transition={{ duration: DURATION.base }}
        onClick={() => void requestClose()}
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, transition: { duration: DURATION.base, ease: EASE.exit } }}
        transition={{ duration: reduced ? DURATION.fast : DURATION.slow, ease: EASE.standard }}
        className="relative flex h-full w-full flex-col overflow-hidden border-card-border bg-card-bg shadow-2xl focus:outline-none sm:h-auto sm:max-h-[92vh] sm:max-w-2xl sm:rounded-3xl sm:border lg:max-w-4xl lg:flex-row"
      >
        {/* The step rail — at the side on lg; below it the progress bar says the same. */}
        <aside className="hidden w-64 shrink-0 flex-col gap-1 border-e border-card-border bg-[var(--bg-inner)] p-5 lg:flex">
          <p className="mb-3 flex items-center gap-2 text-sm font-bold text-text-primary">
            {TitleIcon && <TitleIcon size={16} className="text-primary" aria-hidden />}
            {title}
          </p>
          <ol className="relative flex flex-col gap-1">
            {steps.map((s, i) => {
              const Icon = s.icon;
              const isDone = i < index || finished;
              const current = i === index && !finished;
              const reachable = i <= reached && !finished && !busy;
              return (
                <li key={s.id} className="relative">
                  {current && (
                    <motion.span
                      layoutId={reduced ? undefined : `${id}-rail`}
                      className="absolute inset-0 rounded-xl bg-card-bg shadow-sm"
                      transition={{ duration: DURATION.base, ease: EASE.standard }}
                      aria-hidden
                    />
                  )}
                  <button
                    type="button"
                    disabled={!reachable}
                    onClick={() => wizard.goTo(i)}
                    aria-current={current ? "step" : undefined}
                    className={cn(
                      "relative flex w-full items-center gap-3 rounded-xl px-2 py-2 text-start transition-colors disabled:cursor-default",
                      !current && reachable && "hover:bg-card-bg/60",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-8 shrink-0 place-items-center rounded-full border text-xs font-bold transition-colors duration-300",
                        isDone
                          ? "border-transparent bg-primary text-on-accent"
                          : current
                            ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)] text-primary"
                            : "border-card-border text-text-secondary",
                      )}
                    >
                      {isDone ? <Check size={14} aria-hidden /> : Icon ? <Icon size={14} aria-hidden /> : i + 1}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className={cn("text-xs font-bold", current || isDone ? "text-text-primary" : "text-text-secondary")}>{s.title}</span>
                      {s.subtitle && <span className="line-clamp-1 text-[10px] text-text-secondary">{s.subtitle}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-card-border px-4 pb-3 pt-4 sm:px-6">
            <div className="flex items-start justify-between gap-3">
              {finished ? (
                <span id={`${id}-title`} className="text-sm font-bold text-text-primary">
                  {title}
                </span>
              ) : (
                <div className="flex min-w-0 items-center gap-3">
                  {StepIcon && (
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--leaf-bg)] text-primary">
                      <StepIcon size={20} aria-hidden />
                    </span>
                  )}
                  <div className="min-w-0">
                    <p className="text-[11px] font-bold text-text-secondary">{t("common", K.wizard.stepOf, { current: String(index + 1), total: String(total) })}</p>
                    <h2 id={`${id}-title`} className="truncate text-base font-bold text-text-primary">
                      {step.title}
                    </h2>
                  </div>
                </div>
              )}
              <IconButton aria-label={t("common", K.dialog.close)} icon={<X size={18} aria-hidden />} variant="quiet" size="sm" onClick={() => void requestClose()} />
            </div>
            {!finished && (
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--leaf-bg)]" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={index + 1}>
                <motion.div
                  className="h-full rounded-full bg-primary"
                  initial={false}
                  animate={{ width: `${((index + 1) / total) * 100}%` }}
                  transition={{ duration: reduced ? 0 : DURATION.slow, ease: EASE.standard }}
                />
              </div>
            )}
          </header>

          <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 sm:px-6">
            {finished ? (
              done
            ) : (
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={step.id}
                  initial={slide}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduced ? DURATION.fast : DURATION.base, ease: EASE.standard }}
                  className="flex flex-col gap-5"
                >
                  {intro}
                  {children}
                  {tip && (
                    <aside className="flex items-start gap-3 rounded-2xl border border-dashed border-[var(--accent-primary)]/40 bg-[var(--leaf-bg)] p-3">
                      <Lightbulb size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                      <p className="text-xs leading-6 text-text-primary">
                        <b>{t("common", K.wizard.tip)}: </b>
                        {tip}
                      </p>
                    </aside>
                  )}
                  {error && (
                    <p role="alert" className="flex items-center gap-2 rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)] p-3 text-xs font-bold text-error">
                      <TriangleAlert size={14} className="shrink-0" aria-hidden />
                      {error}
                    </p>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </div>

          {!finished && (
            <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-card-border bg-card-bg px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
              {index > 0 ? (
                <Button variant="quiet" icon={<BackIcon size={16} aria-hidden />} disabled={busy} onClick={() => wizard.goTo(index - 1)}>
                  {t("common", K.wizard.back)}
                </Button>
              ) : (
                <Button variant="quiet" onClick={() => void requestClose()}>
                  {t("common", K.wizard.cancel)}
                </Button>
              )}
              {last ? (
                <Button className="min-w-36" loading={busy} icon={<Check size={16} aria-hidden />} onClick={onSubmit}>
                  {submitLabel}
                </Button>
              ) : (
                <Button className="min-w-32" iconEnd={<NextIcon size={16} aria-hidden />} onClick={() => wizard.next()}>
                  {t("common", K.wizard.next)}
                </Button>
              )}
            </footer>
          )}
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}
