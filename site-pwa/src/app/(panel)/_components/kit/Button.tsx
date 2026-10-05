"use client";

import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { haptic } from "@/lib/haptics";
import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-on-accent shadow-md shadow-primary-glow hover:brightness-105",
  secondary: "border border-card-border bg-card-bg text-text-primary hover:border-primary hover:bg-leaf-bg",
  quiet: "text-text-secondary hover:bg-leaf-bg hover:text-text-primary",
  danger: "bg-error text-on-error hover:brightness-105",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-xl px-3 text-xs",
  md: "h-10 gap-2 rounded-xl px-4 text-sm",
  lg: "h-12 gap-2 rounded-2xl px-5 text-base",
};

const SQUARE: Record<ButtonSize, string> = {
  sm: "size-8 rounded-xl",
  md: "size-10 rounded-xl",
  lg: "size-12 rounded-2xl",
};

const ICON_PX: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 18 };

/** Shared by every button: press, disabled, and the motion level's switch (M3). */
const BASE =
  "relative inline-flex shrink-0 select-none items-center justify-center font-bold whitespace-nowrap transition-[background-color,border-color,color,filter,transform] duration-[120ms] motion-safe:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50";

/**
 * A kit button's look for something that is not a `<button>` — a `Link` that
 * navigates (K3). Same variants, sizes and press as `Button`; the caller's
 * element keeps its own semantics.
 */
export function buttonClass({
  variant = "secondary",
  size = "md",
  fullWidth = false,
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean; className?: string } = {}): string {
  return cn(BASE, VARIANT[variant], SIZE[size], fullWidth && "w-full", className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and shows a spinner, keeping the label and the width (K3). */
  loading?: boolean;
  /** At the start side; a spinner takes its place while loading. */
  icon?: ReactNode;
  /** At the end side — a chevron, an external-link mark. */
  iconEnd?: ReactNode;
  fullWidth?: boolean;
}

/**
 * The panel's one button (UX-1-c, `contract.ux.md` K3). `type` defaults to
 * `button`: a kit button inside a form submits only when it says so.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading = false, icon, iconEnd, fullWidth, className, children, disabled, type = "button", onClick, ...rest },
  ref,
) {
  const spinner = <Loader2 size={ICON_PX[size]} aria-hidden className="animate-spin" />;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANT[variant], SIZE[size], fullWidth && "w-full", className)}
      onClick={(e) => {
        // M6: a primary press is felt in Telegram's Mini App; elsewhere nothing.
        if (variant === "primary") haptic.tap();
        onClick?.(e);
      }}
      {...rest}
    >
      {icon ? (loading ? spinner : icon) : null}
      {/*
        With no icon to swap, the spinner sits over the label and the label
        turns transparent — still there, so the width and the accessible name
        do not change.
      */}
      {loading && !icon && <span className="absolute inset-0 grid place-items-center">{spinner}</span>}
      <span className={cn("truncate", loading && !icon && "opacity-0")}>{children}</span>
      {iconEnd}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, "children" | "iconEnd" | "fullWidth"> {
  /** Required: an icon alone names nothing (K3). */
  "aria-label": string;
  icon: ReactNode;
}

/** A square `Button` holding one icon, named by the `aria-label` it requires. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = "quiet", size = "md", loading = false, icon, className, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BASE, VARIANT[variant], SQUARE[size], className)}
      {...rest}
    >
      {loading ? <Loader2 size={ICON_PX[size]} aria-hidden className="animate-spin" /> : icon}
    </button>
  );
});
