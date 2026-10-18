"use client";

import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { isPlatformTenant } from "@/lib/tenant-type";
import { CHANNELS, COUPON_KEYS, WEEKDAYS, WEEKDAY_KEYS, isFrozen, type CouponForm } from "../_lib/coupon-form";
import { HOURS_FROM, HOURS_TO, hourLabel, type FieldStep } from "../_lib/coupon-steps";
import { variantOwnerTenant } from "../_lib/variant-choices";
import { readProductChoices, useChoiceList } from "../_hooks/useChoiceList";
import { memberSearchOf } from "../../groups/_lib/user-groups";
import { DatePicker } from "../../_components/kit/DatePicker";
import { Select } from "../../_components/kit/Select";
import { Toggle } from "../../_components/kit/Toggle";
import { IdsPicker } from "./IdsPicker";
import { ResellerPicker } from "./ResellerPicker";
import { UsersPicker } from "./UsersPicker";
import { VariantPicker, useVariantOptions } from "./VariantPicker";
import { gatewayKey, isPlatformCoupon, toggleIn, useAdminGateways, useFieldKit, type CouponFields } from "./coupon-fields-ui";

const F = COUPON_KEYS.form;

/** The tenant whose users and catalog a coupon names: the edited coupon's, or the owner picked (`null` = the platform's). */
export const couponTenant = ({ form, me, coupon }: Pick<CouponFields, "form" | "me" | "coupon">) =>
  coupon ? coupon.tenantId : variantOwnerTenant(form.owner, form.tenantId, me);

/**
 * One step's fields (UX-3-b) — the wizard draws one at a time, the edit sheet
 * all five in framed sections. Both read the same form and the same rules.
 */
export function CouponStepFields({ step, ...c }: CouponFields & { step: FieldStep }) {
  switch (step) {
    case "basics":
      return <Basics {...c} />;
    case "limits":
      return <Limits {...c} />;
    case "schedule":
      return <Schedule {...c} />;
    case "audience":
      return <Audience {...c} />;
    case "where":
      return <Where {...c} />;
  }
}

function Basics(c: CouponFields) {
  const { t } = useLocale();
  const { form, set, errors, coupon, me } = c;
  const { field, text } = useFieldKit(c);
  const frozen = coupon ? isFrozen(coupon) : false;
  return (
    <div className="flex flex-col gap-4">
      {isPlatformTenant(me?.tenant?.type) && !coupon && (
        <div className="grid gap-3 sm:grid-cols-2">
          {field(
            "owner",
            t("common", F.owner),
            <Select
              id="cp-owner"
              value={form.owner}
              onChange={(v) => set("owner", v as CouponForm["owner"])}
              options={[
                { value: "own", label: t("common", F.ownerOwn) },
                { value: "platform", label: t("common", F.ownerPlatform) },
                { value: "tenant", label: t("common", F.ownerTenant) },
              ]}
            />,
          )}
          {form.owner === "tenant" && (
            <div className="sm:col-span-2">
              {field("tenantId", t("common", F.tenantId), <ResellerPicker id="cp-tenantId" value={form.tenantId} onChange={(v) => set("tenantId", v)} invalid={Boolean(errors.tenantId)} />)}
            </div>
          )}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("code", t("common", F.code), text("code", { ltr: true }), t("common", F.codeHint))}
        {field("label", t("common", F.label), text("label"))}
      </div>
      {frozen && <p className="rounded-xl bg-[var(--leaf-bg)] p-2 text-2xs text-text-secondary">{t("common", F.frozen)}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        {field(
          "discountType",
          t("common", F.type),
          <Select
            id="cp-discountType"
            disabled={frozen}
            value={form.discountType}
            onChange={(v) => set("discountType", v as CouponForm["discountType"])}
            options={[
              { value: "percentage", label: t("common", F.percentage) },
              { value: "fixed_amount", label: t("common", F.fixed) },
              { value: "free_grant", label: t("common", F.freeService) },
            ]}
          />,
        )}
        {form.discountType === "free_grant"
          ? field(
              "grantVariantId",
              t("common", F.grantVariantId),
              <VariantPicker id="cp-grantVariantId" value={form.grantVariantId} onChange={(v) => set("grantVariantId", v)} ownerTenant={couponTenant(c)} invalid={Boolean(errors.grantVariantId)} disabled={frozen} />,
              t("common", F.grantVariantHint),
            )
          : field("discountValue", t("common", F.value), text("discountValue", { ltr: true, decimal: true, disabled: frozen }))}
        {form.discountType === "percentage" && field("maxDiscountCap", t("common", F.cap), text("maxDiscountCap", { ltr: true, decimal: true }))}
      </div>
      <Toggle checked={form.isActive} onChange={(v) => set("isActive", v)} label={t("common", F.isActive)} />
      {field("note", t("common", F.note), text("note", { area: true }), t("common", F.noteHint))}
    </div>
  );
}

function Limits(c: CouponFields) {
  const { t } = useLocale();
  const { field, text } = useFieldKit(c);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {field("minPurchaseAmount", t("common", F.minPurchase), text("minPurchaseAmount", { ltr: true, decimal: true }))}
      {field("maxPurchaseAmount", t("common", F.maxPurchase), text("maxPurchaseAmount", { ltr: true, decimal: true }))}
      {field("totalUsageLimit", t("common", F.totalLimit), text("totalUsageLimit", { ltr: true }), t("common", F.totalLimitHint))}
      {field("perUserUsageLimit", t("common", F.perUserLimit), text("perUserUsageLimit", { ltr: true }), t("common", F.perUserHint))}
      {field("periodUsageLimit", t("common", F.periodUsageLimit), text("periodUsageLimit", { ltr: true }))}
      {field("periodDays", t("common", F.periodDays), text("periodDays", { ltr: true }))}
    </div>
  );
}

function Schedule(c: CouponFields) {
  const { t } = useLocale();
  const { form, set, errors } = c;
  const { field, chips } = useFieldKit(c);
  // An empty box is "any hour"; billing still reads the pair both-or-neither (rule 3).
  const hours = (k: "activeHourFrom" | "activeHourTo", values: readonly number[]) => (
    <Select
      id={`cp-${k}`}
      value={form[k]}
      onChange={(v) => set(k, v)}
      invalid={Boolean(errors[k])}
      options={[{ value: "", label: t("common", F.anyHour) }, ...values.map((h) => ({ value: String(h), label: hourLabel(h) }))]}
    />
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {field("validFrom", t("common", F.validFrom), <DatePicker value={form.validFrom} onChange={(v) => set("validFrom", v ?? "")} placeholder={t("common", F.startsNow)} />)}
        {field("expiresAt", t("common", F.expiresAt), <DatePicker value={form.expiresAt} onChange={(v) => set("expiresAt", v ?? "")} placeholder={t("common", F.neverExpires)} />)}
      </div>
      {field(
        "activeWeekdays",
        t("common", F.weekdays),
        chips(WEEKDAYS, form.activeWeekdays as (typeof WEEKDAYS)[number][], (d) => t("common", WEEKDAY_KEYS[d]), (d) => set("activeWeekdays", toggleIn(form.activeWeekdays, d))),
        t("common", F.weekdaysHint),
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("activeHourFrom", t("common", F.hourFrom), hours("activeHourFrom", HOURS_FROM))}
        {field("activeHourTo", t("common", F.hourTo), hours("activeHourTo", HOURS_TO), t("common", F.hoursHint))}
      </div>
    </div>
  );
}

function Audience(c: CouponFields) {
  const { t } = useLocale();
  const { form, set, errors, me } = c;
  const { field, text } = useFieldKit(c);
  // Whose users a targeted coupon names: its owner's, through the caller's own door (UX-3-a).
  const tenant = couponTenant(c);
  const door = tenant === "" ? { via: "ids" as const, tenantId: "" } : { via: memberSearchOf(me, tenant), tenantId: tenant ?? me?.tenant?.id ?? "" };
  return (
    <div className="flex flex-col gap-4">
      {field(
        "visibility",
        t("common", F.visibility),
        <Select
          id="cp-visibility"
          value={form.visibility}
          onChange={(v) => set("visibility", v as CouponForm["visibility"])}
          options={[
            { value: "public", label: t("common", F.public) },
            { value: "targeted", label: t("common", F.targeted) },
          ]}
        />,
      )}
      {form.visibility === "targeted" &&
        field("allowedUserIds", t("common", F.userIds), <UsersPicker id="cp-allowedUserIds" value={form.allowedUserIds} onChange={(v) => set("allowedUserIds", v)} {...door} invalid={Boolean(errors.allowedUserIds)} />, t("common", F.userIdsHint))}
      <Toggle checked={form.firstPurchaseOnly} onChange={(v) => set("firstPurchaseOnly", v)} label={t("common", F.firstPurchaseOnly)} />
      {field("newUserWithinDays", t("common", F.newUserWithinDays), text("newUserWithinDays", { ltr: true }))}
    </div>
  );
}

function Where(c: CouponFields) {
  const { t } = useLocale();
  const { form, set, errors } = c;
  const { field, chips } = useFieldKit(c);
  const gateways = useAdminGateways();
  const products = useChoiceList(readProductChoices);
  const variants = useVariantOptions(couponTenant(c));
  const platform = isPlatformCoupon(c);
  const gatewayChoices = (gateways ?? []).filter((g) => !platform || g.source === "platform");
  return (
    <div className="flex flex-col gap-4">
      {field(
        "allowedChannels",
        t("common", F.channels),
        chips(CHANNELS, form.allowedChannels, (ch) => t("common", F.channel[ch]), (ch) => set("allowedChannels", toggleIn(form.allowedChannels, ch))),
        t("common", F.channelsHint),
      )}
      {field(
        "gateways",
        t("common", F.gateways),
        gateways === null ? (
          <Loader2 size={14} className="animate-spin text-primary" aria-hidden />
        ) : gatewayChoices.length === 0 ? (
          <span className="text-2xs text-text-secondary">{t("common", F.noGateways)}</span>
        ) : (
          chips(
            gatewayChoices.map(gatewayKey),
            form.gateways,
            (key) => gatewayChoices.find((g) => gatewayKey(g) === key)?.displayName ?? key,
            (key) => set("gateways", toggleIn(form.gateways, key)),
          )
        ),
        t("common", F.gatewaysHint),
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("productIds", t("common", F.productIds), <IdsPicker id="cp-productIds" value={form.productIds} onChange={(v) => set("productIds", v)} choices={products} invalid={Boolean(errors.productIds)} />, t("common", F.scopeHint))}
        {field("variantIds", t("common", F.variantIds), <IdsPicker id="cp-variantIds" value={form.variantIds} onChange={(v) => set("variantIds", v)} choices={variants} invalid={Boolean(errors.variantIds)} />)}
      </div>
    </div>
  );
}
