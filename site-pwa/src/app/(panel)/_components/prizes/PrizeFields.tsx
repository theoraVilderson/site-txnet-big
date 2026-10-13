"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { AdminCoupon } from "@/lib/billing-api";
import { Button, IconButton, Input } from "../kit";
import { Select } from "../kit/Select";
import { Field } from "../../catalog/_components/catalog-ui";
import { VariantPicker } from "../../coupons/_components/VariantPicker";
import type { PrizeSource } from "../../_hooks/usePrizeSources";

/** The prize keys every prize editor's namespace has (`wheelSettings.prizes`, `lotteryAdmin.prizes`). */
export type PrizeKeys = Record<
  | "label" | "type" | "moveUp" | "moveDown" | "remove" | "valueGb" | "valueDays" | "valuePercent"
  | "template" | "templateId" | "templatesLoading" | "noTemplates" | "validDays" | "variant",
  string
>;

/** What every prize form has, whatever else its editor adds (weight, winners). */
export type PrizeCore<T extends string> = {
  label: string;
  prizeType: T;
  prizeValue: string;
  couponTemplateId: string;
  couponValidDays: string;
  variantId: string;
};

/** The types whose prize carries a figure: GB, days, or a percent off. */
const VALUED: readonly string[] = ["bonus_traffic_gb", "extra_days", "discount_coupon"];

/** A prize row's top line: its title, and moving it up or down or taking it out. */
export function PrizeRowHeader({ title, index, count, keys, onMove, onRemove }: {
  title: ReactNode;
  index: number;
  count: number;
  keys: PrizeKeys;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-bold text-text-primary">{title}</span>
      <div className="flex gap-1">
        <IconButton size="sm" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t("common", keys.moveUp)} icon={<ArrowUp size={12} aria-hidden />} />
        <IconButton size="sm" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={t("common", keys.moveDown)} icon={<ArrowDown size={12} aria-hidden />} />
        <Button variant="quiet" size="sm" onClick={onRemove} icon={<Trash2 size={12} aria-hidden />}>
          {t("common", keys.remove)}
        </Button>
      </div>
    </div>
  );
}

/**
 * The fields every prize has: its label, its type, the figure a valued type
 * carries, the coupon a discount copies and how long it lasts, the variant a
 * free grant gives. A type that carries no figure writes "0" for it. The
 * editor puts its own fields after these, in the same grid.
 */
export function PrizeFields<T extends string>({ prize: p, errors: e, keys, types, typeKeys, templates, variantFieldId, ownerTenant, onPatch }: {
  prize: PrizeCore<T>;
  errors: Partial<Record<keyof PrizeCore<T>, string>>;
  keys: PrizeKeys;
  types: readonly T[];
  typeKeys: Record<T, string>;
  templates: PrizeSource<AdminCoupon>;
  variantFieldId: string;
  ownerTenant: string | null;
  onPatch: (patch: Partial<PrizeCore<T>>) => void;
}) {
  const { t } = useLocale();
  return (
    <>
      <Field label={t("common", keys.label)} error={e.label}>
        <Input dir="auto" value={p.label} onChange={(ev) => onPatch({ label: ev.target.value })} />
      </Field>
      <Field label={t("common", keys.type)}>
        <Select
          value={p.prizeType}
          onChange={(v) => onPatch({ prizeType: v as T, ...(VALUED.includes(v) ? {} : { prizeValue: "0" }) })}
          options={types.map((type) => ({ value: type, label: t("common", typeKeys[type]) }))}
        />
      </Field>
      {VALUED.includes(p.prizeType) && (
        <Field
          label={t("common", p.prizeType === "bonus_traffic_gb" ? keys.valueGb : p.prizeType === "extra_days" ? keys.valueDays : keys.valuePercent)}
          error={e.prizeValue}
        >
          <Input dir="ltr" inputMode="decimal" value={p.prizeValue} onChange={(ev) => onPatch({ prizeValue: ev.target.value })} />
        </Field>
      )}
      {p.prizeType === "discount_coupon" && (
        <>
          <Field label={t("common", keys.template)} error={e.couponTemplateId}>
            {templates === null ? (
              <p className="py-2 text-xs text-text-secondary">{t("common", keys.templatesLoading)}</p>
            ) : templates === "failed" ? (
              <Input dir="ltr" placeholder={t("common", keys.templateId)} value={p.couponTemplateId} onChange={(ev) => onPatch({ couponTemplateId: ev.target.value })} />
            ) : templates.length === 0 ? (
              <p className="py-2 text-xs text-text-secondary">{t("common", keys.noTemplates)}</p>
            ) : (
              <Select
                value={p.couponTemplateId}
                onChange={(v) => onPatch({ couponTemplateId: v })}
                options={templates.map((c) => ({ value: c.id, label: `${c.code}${c.label ? ` · ${c.label}` : ""}` }))}
              />
            )}
          </Field>
          <Field label={t("common", keys.validDays)} error={e.couponValidDays}>
            <Input dir="ltr" inputMode="numeric" value={p.couponValidDays} onChange={(ev) => onPatch({ couponValidDays: ev.target.value })} />
          </Field>
        </>
      )}
      {p.prizeType === "free_grant" && (
        <Field label={t("common", keys.variant)} error={e.variantId}>
          <VariantPicker id={variantFieldId} value={p.variantId} onChange={(v) => onPatch({ variantId: v })} ownerTenant={ownerTenant} invalid={!!e.variantId} />
        </Field>
      )}
    </>
  );
}
