"use client";

import type { ReactNode } from "react";
import { CalendarClock, Gauge, MapPin, TicketPercent, Users, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { CHANNELS, COUPON_KEYS, WEEKDAY_KEYS, type CouponForm } from "../_lib/coupon-form";
import { idsOf } from "../_lib/discount-rules";
import { FIELD_STEPS, STEP_FIELDS, hourLabel, setFields, type FieldStep } from "../_lib/coupon-steps";
import { formatPlatformDay } from "../../_lib/datetime";
import { formatList } from "../../_lib/digits";
import { ReviewRows, type ReviewRow } from "../../_components/kit";
import { SHORT_ID } from "./PickedChips";
import { gatewayKey, useAdminGateways } from "./coupon-fields-ui";

const F = COUPON_KEYS.form;
const W = F.wizard;
const ICONS: Record<FieldStep, LucideIcon> = { basics: TicketPercent, limits: Gauge, schedule: CalendarClock, audience: Users, where: MapPin };
/** Shown on the review whatever was typed: the coupon itself, and when it stops (UX-3-b: an empty end is said, never left blank). */
const ALWAYS: Partial<Record<keyof CouponForm, true>> = { code: true, discountType: true, discountValue: true, grantVariantId: true, expiresAt: true };
/** The type's own fields: a value for money off, a variant for a free service. */
const NOT_FOR: Record<CouponForm["discountType"], (keyof CouponForm)[]> = {
  percentage: ["grantVariantId"],
  fixed_amount: ["grantVariantId", "maxDiscountCap"],
  free_grant: ["discountValue", "maxDiscountCap"],
};

/**
 * The wizard's last step (UX-3-b, K5): each step's choices with a way back to
 * it — only what was set, so the defaults do not read as decisions. The code,
 * its type and value, and its end ("never expires") always show.
 */
export function CouponReview({ form, onEdit }: { form: CouponForm; onEdit: (step: FieldStep) => void }) {
  const { t, lang } = useLocale();
  const gateways = useAdminGateways();
  const value = useValueText(form, lang, (key) => (gateways ?? []).find((g) => gatewayKey(g) === key)?.displayName ?? key);

  const rowsOf = (step: FieldStep): ReviewRow[] =>
    STEP_FIELDS[step]
      .filter((k) => (ALWAYS[k] || setFields(form, step).includes(k)) && !NOT_FOR[form.discountType].includes(k))
      .map((k) => [t("common", LABELS[k]), value(k)]);

  return (
    <div className="flex flex-col gap-3">
      {FIELD_STEPS.map((step) => {
        const rows = rowsOf(step);
        return (
          <section key={step} className="rounded-2xl border border-card-border p-4">
            <ReviewRows icon={ICONS[step]} title={t("common", F.sections[step].title)} editLabel={t("common", W.edit)} onEdit={() => onEdit(step)} rows={rows} />
            {rows.length === 0 && <p className="text-xs text-text-secondary">{t("common", W.nothingSet)}</p>}
          </section>
        );
      })}
    </div>
  );
}

/** Each field's label on the review — the form's own. */
const LABELS: Record<keyof CouponForm, string> = {
  owner: F.owner,
  tenantId: F.tenantId,
  code: F.code,
  label: F.label,
  discountType: F.type,
  discountValue: F.value,
  grantVariantId: F.grantVariantId,
  maxDiscountCap: F.cap,
  isActive: F.isActive,
  note: F.note,
  minPurchaseAmount: F.minPurchase,
  maxPurchaseAmount: F.maxPurchase,
  totalUsageLimit: F.totalLimit,
  perUserUsageLimit: F.perUserLimit,
  periodUsageLimit: F.periodUsageLimit,
  periodDays: F.periodDays,
  validFrom: F.validFrom,
  expiresAt: F.expiresAt,
  activeWeekdays: F.weekdays,
  activeHourFrom: F.hourFrom,
  activeHourTo: F.hourTo,
  visibility: F.visibility,
  allowedUserIds: F.userIds,
  firstPurchaseOnly: F.firstPurchaseOnly,
  newUserWithinDays: F.newUserWithinDays,
  allowedChannels: F.channels,
  gateways: F.gateways,
  productIds: F.productIds,
  variantIds: F.variantIds,
};

/** One field's value as the review says it. */
function useValueText(form: CouponForm, lang: string, gatewayName: (key: string) => string) {
  const { t } = useLocale();
  const yes = (on: boolean) => t("common", on ? W.yes : W.no);
  const count = (text: string) => t("common", W.count, { count: idsOf(text).length });
  const short = (id: string) => <span dir="ltr">{id.trim().slice(0, SHORT_ID)}</span>;
  const TYPES = { percentage: F.percentage, fixed_amount: F.fixed, free_grant: F.freeService } as const;
  const OWNERS = { own: F.ownerOwn, platform: F.ownerPlatform, tenant: F.ownerTenant } as const;

  return function valueText(k: keyof CouponForm): ReactNode {
    switch (k) {
      case "owner":
        return t("common", OWNERS[form.owner]);
      case "tenantId":
      case "grantVariantId":
        return short(form[k]);
      case "code":
        return <span dir="ltr">{form.code.trim().toUpperCase()}</span>;
      case "discountType":
        return t("common", TYPES[form.discountType]);
      case "isActive":
      case "firstPurchaseOnly":
        return yes(form[k]);
      case "validFrom":
        return formatPlatformDay(form.validFrom, lang);
      case "expiresAt":
        return form.expiresAt ? formatPlatformDay(form.expiresAt, lang) : t("common", F.neverExpires);
      case "activeWeekdays":
        return formatList([...form.activeWeekdays].sort().map((d) => t("common", WEEKDAY_KEYS[d as keyof typeof WEEKDAY_KEYS])), lang);
      case "activeHourFrom":
      case "activeHourTo":
        return <span dir="ltr">{hourLabel(Number(form[k]))}</span>;
      case "visibility":
        return t("common", form.visibility === "targeted" ? F.targeted : F.public);
      case "allowedUserIds":
      case "productIds":
      case "variantIds":
        return count(form[k]);
      case "allowedChannels":
        return formatList(CHANNELS.filter((c) => form.allowedChannels.includes(c)).map((c) => t("common", F.channel[c])), lang);
      case "gateways":
        return formatList(form.gateways.map(gatewayName), lang);
      default:
        return <span dir="auto">{String(form[k]).trim()}</span>;
    }
  };
}
