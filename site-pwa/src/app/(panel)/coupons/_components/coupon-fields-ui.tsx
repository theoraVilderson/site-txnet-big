"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { Me } from "@/lib/auth-api";
import { billingApi, type AdminCoupon, type AdminGateway } from "@/lib/billing-api";
import { isPlatformTenant } from "@/lib/tenant-type";
import type { CouponForm, CouponFormErrors } from "../_lib/coupon-form";
import { Input, Textarea } from "../../_components/kit";

/** Set one field of the form; the host clears that field's error. */
export type SetCouponField = <Key extends keyof CouponForm>(k: Key, v: CouponForm[Key]) => void;

/** What every coupon step or section is drawn from — the wizard's and the edit sheet's alike (UX-3-b). */
export interface CouponFields {
  form: CouponForm;
  set: SetCouponField;
  errors: CouponFormErrors;
  me: Me | null;
  /** The coupon being edited; `null` in the wizard. */
  coupon: AdminCoupon | null;
  /** What its money is written in (F-116-h11): the coupon's own, or billing's for a new one; `null` until known. */
  currency: string | null;
}

/** Whether the coupon is the platform's — it may then name platform gateways only (rule 6). */
export function isPlatformCoupon({ form, me, coupon }: Pick<CouponFields, "form" | "me" | "coupon">): boolean {
  return coupon ? coupon.tenantId === null : isPlatformTenant(me?.tenant?.type) && form.owner === "platform";
}

/** The gateways a coupon may be limited to, read once: `null` while loading, `[]` when refused. */
export function useAdminGateways(): AdminGateway[] | null {
  const [gateways, setGateways] = useState<AdminGateway[] | null>(null);
  useEffect(() => {
    billingApi.adminGateways().then(setGateways, () => setGateways([]));
  }, []);
  return gateways;
}

/** `source:id`, the form's key for one gateway. */
export const gatewayKey = (g: Pick<AdminGateway, "source" | "id">) => `${g.source}:${g.id}`;

/** Add a value to a list, or take it out when it is in. */
export const toggleIn = <V,>(list: readonly V[], v: V): V[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/**
 * The coupon form's field frame and plain controls: a label tied to the
 * control by `cp-<field>`, then the field's own error or its hint.
 */
export function useFieldKit({ form, set, errors }: Pick<CouponFields, "form" | "set" | "errors">) {
  const { t } = useLocale();

  const field = (k: keyof CouponForm, label: string, control: ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`cp-${k}`} className="text-xs font-bold text-text-primary">
        {label}
      </label>
      {control}
      {errors[k] ? (
        <span role="alert" className="text-2xs font-bold text-error">
          {t("common", errors[k] ?? "")}
        </span>
      ) : (
        hint && <span className="text-2xs text-text-secondary">{hint}</span>
      )}
    </div>
  );

  const text = (k: keyof CouponForm, opts: { ltr?: boolean; decimal?: boolean; disabled?: boolean; area?: boolean } = {}) =>
    opts.area ? (
      <Textarea id={`cp-${k}`} dir={opts.ltr ? "ltr" : undefined} rows={3} className="font-mono text-xs" aria-invalid={Boolean(errors[k])} value={String(form[k])} onChange={(e) => set(k, e.target.value as never)} />
    ) : (
      <Input
        id={`cp-${k}`}
        dir={opts.ltr ? "ltr" : undefined}
        inputMode={opts.decimal ? "decimal" : undefined}
        disabled={opts.disabled}
        aria-invalid={Boolean(errors[k])}
        value={String(form[k])}
        onChange={(e) => set(k, e.target.value as never)}
      />
    );

  const chips = <V extends string | number>(values: readonly V[], selected: readonly V[], label: (v: V) => string, onToggle: (v: V) => void) => (
    <div className="flex flex-wrap gap-2">
      {values.map((v) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={selected.includes(v)}
          onClick={() => onToggle(v)}
          className={`rounded-xl border px-3 py-1.5 text-xs font-bold transition-colors ${selected.includes(v) ? "border-primary bg-primary text-on-accent" : "border-card-border bg-[var(--bg-inner)] text-text-secondary hover:border-[var(--accent-primary)]"}`}
        >
          {label(v)}
        </button>
      ))}
    </div>
  );

  return { field, text, chips };
}
