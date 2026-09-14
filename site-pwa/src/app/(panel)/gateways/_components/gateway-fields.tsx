"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Bitcoin, Check, ChevronDown, CircleCheckBig, CreditCard, Eye, EyeOff, Landmark, Percent, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { BASE_CURRENCY } from "../../_lib/money";
import type { FormError, FormErrors, GatewayForm } from "../_lib/gateway-form";
import { feePreview, type Provider } from "../_lib/gateway-wizard";

const G = FrontendI18nKeys.common.gateways;
const F = G.form;
const W = G.wizard;

/**
 * The controls the add wizard and the edit screen share, so a gateway is set
 * up and changed through the same fields. Nothing here validates or serialises
 * — `gateway-form.ts` does.
 */

export type SetField = <K extends keyof GatewayForm>(k: K, v: GatewayForm[K]) => void;

export const PROVIDER_ICONS: Record<Provider, LucideIcon> = {
  zarinpal: Landmark,
  idpay: Landmark,
  nowpayments: Bitcoin,
  stripe: CreditCard,
};

/** The same field look as the kit's `Select`, so a row of mixed controls reads as one form. */
export const inputClass =
  "w-full rounded-xl border border-card-border bg-[var(--bg-inner)] px-3 py-2.5 text-sm text-[var(--text-input)] placeholder:text-[var(--text-label)] transition-colors hover:border-[var(--accent-primary)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]";
const invalidClass = "border-error focus:border-error";

export function Field({
  id,
  label,
  error,
  hint,
  optional = false,
  children,
}: {
  id: string;
  label: string;
  error?: FormError;
  hint?: string;
  optional?: boolean;
  children: ReactNode;
}) {
  const { t } = useLocale();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex items-center gap-2 text-xs font-bold text-text-primary">
        {label}
        {optional && <span className="font-normal text-text-secondary">({t("common", W.optional)})</span>}
      </label>
      {children}
      {error ? (
        <span role="alert" className="text-[11px] font-bold text-error">
          {t("common", G.errors[error])}
        </span>
      ) : (
        hint && <span className="text-[11px] leading-5 text-text-secondary">{hint}</span>
      )}
    </div>
  );
}

// The wrapper carries the input's direction: with only the input `ltr`, its
// `pe-*` pads the right while the suffix's `end-*` sits left in RTL, on the text.
export function TextInput({
  id,
  value,
  onChange,
  invalid = false,
  ltr = false,
  decimal = false,
  suffix,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  ltr?: boolean;
  decimal?: boolean;
  suffix?: string;
  placeholder?: string;
}) {
  return (
    <div className="relative" dir={ltr ? "ltr" : undefined}>
      <input
        id={id}
        className={`${inputClass} ${invalid ? invalidClass : ""} ${suffix ? "pe-14" : ""}`}
        inputMode={decimal ? "decimal" : undefined}
        placeholder={placeholder}
        aria-invalid={invalid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs font-bold text-text-secondary">{suffix}</span>
      )}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-card-border bg-[var(--bg-inner)] p-3 text-start transition-colors hover:border-[var(--accent-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-glow)]"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-bold text-text-primary">{label}</span>
        {hint && <span className="text-[11px] text-text-secondary">{hint}</span>}
      </span>
      <span className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-primary" : "bg-[var(--leaf-bg)] ring-1 ring-inset ring-card-border"}`}>
        <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${checked ? "start-[1.375rem]" : "start-0.5"}`} />
      </span>
    </button>
  );
}

/** A write-only secret box: never filled from the server, shown only while the eye is open. */
export function SecretInput({
  id,
  value,
  onChange,
  showLabel,
  hideLabel,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  showLabel: string;
  hideLabel: string;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative" dir="ltr">
      <input
        id={id}
        className={`${inputClass} pe-11 font-mono`}
        type={visible ? "text" : "password"}
        autoComplete="new-password"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? hideLabel : showLabel}
        className="absolute inset-y-0 end-1 grid w-9 place-items-center text-text-secondary hover:text-text-primary"
      >
        {visible ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
      </button>
    </div>
  );
}

/** Two or three mutually exclusive choices, as cards: every option visible, no list to open. */
export function ChoiceCards<V extends string>({
  name,
  value,
  options,
  onPick,
}: {
  name: string;
  value: string;
  options: readonly { value: V; title: string; desc?: string; icon?: LucideIcon }[];
  onPick: (v: V) => void;
}) {
  return (
    <div role="radiogroup" aria-label={name} className="grid gap-2 sm:grid-cols-2">
      {options.map((o) => {
        const selected = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onPick(o.value)}
            className={`relative flex items-start gap-3 rounded-2xl border p-3 text-start transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-glow)] ${
              selected ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)] shadow-sm" : "border-card-border bg-[var(--bg-inner)] hover:border-[var(--accent-primary)]"
            }`}
          >
            {Icon && (
              <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${selected ? "bg-primary text-white" : "bg-card-bg text-primary"}`}>
                <Icon size={18} aria-hidden />
              </span>
            )}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-bold text-text-primary">{o.title}</span>
              {o.desc && <span className="text-[11px] leading-5 text-text-secondary">{o.desc}</span>}
            </span>
            {selected && (
              <span className="absolute end-2 top-2 grid size-5 place-items-center rounded-full bg-primary text-white">
                <Check size={12} aria-hidden />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** An amount range in words: either end may be open, and both open is any amount. */
export function useRangeText(money: (amount: string) => string) {
  const { t } = useLocale();
  return (min: string, max: string) => {
    const lo = min.trim();
    const hi = max.trim();
    if (lo && hi) return t("common", G.range.between, { min: money(lo), max: money(hi) });
    if (lo) return t("common", G.range.from, { min: money(lo) });
    if (hi) return t("common", G.range.upTo, { max: money(hi) });
    return t("common", G.range.any);
  };
}

/** Fee mode, value, floor and ceiling, with the exact preview `feePreview` computes. */
export function FeeFields({ form, set, errors, money }: { form: GatewayForm; set: SetField; errors: FormErrors; money: (amount: string) => string }) {
  const { t } = useLocale();
  const [sample, setSample] = useState("100");
  const [advanced, setAdvanced] = useState(Boolean(form.feeFloor || form.feeCeiling));
  // A floor or ceiling a save refused is never hidden behind a closed panel.
  const open = advanced || Boolean(errors.feeFloor || errors.feeCeiling);
  const manual = form.feeCalculationMode === "manual";
  const fee = useMemo(() => feePreview(form, sample), [form, sample]);

  const decimal = (k: "feeValue" | "feeFloor" | "feeCeiling", label: string, suffix: string) => (
    <Field id={`gw-${k}`} label={label} error={errors[k]}>
      <TextInput id={`gw-${k}`} value={form[k]} onChange={(v) => set(k, v)} invalid={Boolean(errors[k])} ltr decimal suffix={suffix} />
    </Field>
  );

  return (
    <div className="flex flex-col gap-5">
      <ChoiceCards
        name={t("common", F.feeMode)}
        value={form.feeCalculationMode}
        options={[
          { value: "manual", title: t("common", W.feeModes.manual.title), desc: t("common", W.feeModes.manual.desc), icon: Percent },
          { value: "automatic", title: t("common", W.feeModes.automatic.title), desc: t("common", W.feeModes.automatic.desc), icon: CircleCheckBig },
        ]}
        onPick={(v) => set("feeCalculationMode", v)}
      />

      {manual ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-bold text-text-primary">{t("common", F.feeType)}</span>
            <div role="radiogroup" aria-label={t("common", F.feeType)} className="grid grid-cols-2 gap-1 rounded-xl border border-card-border bg-[var(--bg-inner)] p-1">
              {(["percentage", "fixed"] as const).map((ft) => (
                <button
                  key={ft}
                  type="button"
                  role="radio"
                  aria-checked={form.feeType === ft}
                  onClick={() => set("feeType", ft)}
                  className={`rounded-lg px-2 py-2 text-xs font-bold transition-all ${form.feeType === ft ? "bg-primary text-white shadow-sm" : "text-text-secondary hover:text-text-primary"}`}
                >
                  {t("common", W.feeTypes[ft])}
                </button>
              ))}
            </div>
          </div>
          {decimal("feeValue", t("common", F.feeValue), form.feeType === "percentage" ? "%" : BASE_CURRENCY)}
        </div>
      ) : (
        <p className="rounded-xl bg-[var(--leaf-bg)] p-3 text-xs leading-6 text-text-primary">{t("common", W.hints.automaticNote)}</p>
      )}

      <div className="rounded-2xl border border-card-border">
        <button
          type="button"
          onClick={() => setAdvanced(!open)}
          aria-expanded={open}
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-xs font-bold text-text-primary"
        >
          <span>
            {t("common", W.hints.advanced)} <span className="font-normal text-text-secondary">({t("common", W.optional)})</span>
          </span>
          <ChevronDown size={16} className={`text-text-secondary transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
        {open && (
          <div className="grid gap-4 border-t border-card-border p-3 sm:grid-cols-2">
            {decimal("feeFloor", t("common", F.feeFloor), BASE_CURRENCY)}
            {decimal("feeCeiling", t("common", F.feeCeiling), BASE_CURRENCY)}
          </div>
        )}
      </div>

      {manual && (
        <div className="rounded-2xl bg-[image:var(--card-gradient)] p-4 text-white shadow-md">
          <p className="mb-3 text-xs font-bold opacity-90">{t("common", W.preview.title)}</p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="flex flex-col gap-1 text-[11px] opacity-90">
              {t("common", W.preview.amount)}
              <span className="relative" dir="ltr">
                <input
                  inputMode="decimal"
                  value={sample}
                  onChange={(e) => setSample(e.target.value)}
                  className="w-32 rounded-lg border border-white/30 bg-white/15 px-2 py-1.5 pe-10 text-sm font-bold text-white placeholder:text-white/60 focus:outline-none focus:ring-2 focus:ring-white/40"
                />
                <span className="pointer-events-none absolute inset-y-0 end-2 flex items-center text-[10px] font-bold opacity-80">{BASE_CURRENCY}</span>
              </span>
            </label>
            <div className="text-end">
              <p className="text-[11px] opacity-90">{t("common", W.preview.fee)}</p>
              <p className="text-xl font-bold" dir="ltr">
                {fee === null ? "—" : money(fee)}
              </p>
            </div>
          </div>
          {fee === null && sample.trim() !== "" && <p className="mt-2 text-[11px] opacity-90">{t("common", W.preview.invalid)}</p>}
        </div>
      )}
    </div>
  );
}
