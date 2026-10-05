"use client";

import { AlertCircle, Eye, EyeOff } from "lucide-react";
import {
  forwardRef,
  useId,
  useLayoutEffect,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { numberLocale } from "../../_lib/digits";
import { cn } from "./cn";
import { FieldContext, useFieldControl } from "./field-context";

export { useFieldControl, type FieldControl } from "./field-context";

const K = FrontendI18nKeys.common.kit;

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Replaces the hint while set (K4). A form's own error stays here, inline — never a toast (K10). */
  error?: ReactNode;
  /** Marks the label "optional"; required is the default and carries no mark. */
  optional?: boolean;
  /** The control's id; one is made when absent. */
  id?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A label above, the control, and a hint below that an error replaces (UX-1-c,
 * `contract.ux.md` K4). The control is wired through context — `aria-describedby`
 * names the error while there is one and the hint otherwise, and
 * `aria-invalid` follows the error — so a page cannot forget either.
 */
export function Field({ label, hint, error, optional, id: given, className, children }: FieldProps) {
  const { lang, t } = useLocale();
  const made = useId();
  const id = given ?? made;
  const [count, setCount] = useState<{ length: number; max: number } | null>(null);
  const hasError = error !== undefined && error !== null && error !== false && error !== "";
  const messageId = hasError ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const countId = count ? `${id}-count` : undefined;
  const describedBy = [messageId, countId].filter(Boolean).join(" ") || undefined;
  const n = new Intl.NumberFormat(numberLocale(lang));

  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: hasError, setCount }}>
      <div className={cn("flex flex-col gap-1.5", className)}>
        <label htmlFor={id} className="text-sm font-bold text-text-primary">
          {label}
          {optional && <span className="ms-1.5 text-xs font-normal text-text-secondary">({t("common", K.optional)})</span>}
        </label>
        {children}
        {(hasError || hint || count) && (
          <div className="flex items-start justify-between gap-3 text-xs">
            {hasError ? (
              <p id={messageId} className="flex items-start gap-1 text-error">
                <AlertCircle size={14} aria-hidden className="mt-px shrink-0" />
                <span>{error}</span>
              </p>
            ) : hint ? (
              <p id={messageId} className="text-text-secondary">
                {hint}
              </p>
            ) : (
              <span />
            )}
            {count && (
              <span
                id={countId}
                className={cn("shrink-0 tabular-nums", count.length >= count.max ? "text-error" : "text-text-secondary")}
              >
                {`${n.format(count.length)}/${n.format(count.max)}`}
              </span>
            )}
          </div>
        )}
      </div>
    </FieldContext.Provider>
  );
}

/** The control's wiring inside a Field, with the caller's own props winning. */
function useWired(props: { id?: string; maxLength?: number; value?: unknown; "aria-describedby"?: string; "aria-invalid"?: unknown }) {
  const field = useFieldControl();
  const [typed, setTyped] = useState(0);
  const length = typeof props.value === "string" ? props.value.length : typed;
  const max = props.maxLength;

  useLayoutEffect(() => {
    if (!field) return;
    field.setCount(max ? { length, max } : null);
  }, [field?.setCount, length, max]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => () => field?.setCount(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const invalid = props["aria-invalid"] ?? (field?.invalid || undefined);
  return {
    id: props.id ?? field?.id,
    "aria-describedby": props["aria-describedby"] ?? field?.describedBy,
    "aria-invalid": invalid as boolean | undefined,
    /** Tracks an uncontrolled control's length for the counter. */
    onTyped: (value: string) => setTyped(value.length),
  };
}

const CONTROL =
  "w-full rounded-xl border border-card-border bg-bg-inner px-3 text-sm text-[var(--text-input)] placeholder:text-[var(--text-label)] transition-colors hover:border-primary focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-error";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Drawn inside the box at the end — a unit, a button. */
  end?: ReactNode;
}

/** A text box, h-11 (K4). Inside a `Field` it takes its id and description from it. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, end, onChange, ...rest }, ref) {
  const wired = useWired(rest);
  const input = (
    <input
      ref={ref}
      {...rest}
      id={wired.id}
      aria-describedby={wired["aria-describedby"]}
      aria-invalid={wired["aria-invalid"]}
      onChange={(e) => {
        wired.onTyped(e.target.value);
        onChange?.(e);
      }}
      className={cn(CONTROL, "h-11", end && "pe-11", className)}
    />
  );
  if (!end) return input;
  return (
    <div className="relative">
      {input}
      <div className="absolute inset-y-0 end-0 flex items-center pe-1.5">{end}</div>
    </div>
  );
});

/** A multi-line box, `rounded-xl`, growing with `rows`. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, onChange, rows = 4, ...rest },
  ref,
) {
  const wired = useWired(rest);
  return (
    <textarea
      ref={ref}
      rows={rows}
      {...rest}
      id={wired.id}
      aria-describedby={wired["aria-describedby"]}
      aria-invalid={wired["aria-invalid"]}
      onChange={(e) => {
        wired.onTyped(e.target.value);
        onChange?.(e);
      }}
      className={cn(CONTROL, "min-h-24 resize-y py-2.5 leading-relaxed", className)}
    />
  );
});

/** A password box with a show/hide eye; what it shows is never kept anywhere else. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, "type" | "end">>(function PasswordInput(props, ref) {
  const { t } = useLocale();
  const [visible, setVisible] = useState(false);
  const label = t("common", visible ? K.password.hide : K.password.show);
  return (
    <Input
      ref={ref}
      {...props}
      type={visible ? "text" : "password"}
      dir="ltr"
      autoComplete={props.autoComplete ?? "current-password"}
      end={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={label}
          aria-pressed={visible}
          className="grid size-8 place-items-center rounded-lg text-text-secondary transition-colors hover:bg-leaf-bg hover:text-text-primary"
        >
          {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
        </button>
      }
    />
  );
});
