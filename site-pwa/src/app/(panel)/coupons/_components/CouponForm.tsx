"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { Me } from "@/lib/auth-api";
import { billingApi, type AdminCoupon, type AdminGateway } from "@/lib/billing-api";
import { DatePicker } from "../../_components/kit/DatePicker";
import { Select } from "../../_components/kit/Select";
import { Toggle } from "../../_components/kit/Toggle";
import {
  CHANNELS,
  COUPON_KEYS as K,
  WEEKDAYS,
  WEEKDAY_KEYS,
  createBody,
  emptyCouponForm,
  formFromCoupon,
  isPlatformOwner,
  isFrozen,
  refusalKey,
  updateBody,
  validateCouponForm,
  type CouponForm as Form,
  type CouponFormErrors,
} from "../_lib/coupon-form";
import { variantOwnerTenant } from "../_lib/variant-choices";
import { VariantPicker } from "./VariantPicker";
import { Button, Dialog, Input, Textarea, useConfirm } from "../../_components/kit";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

const F = K.form;


/**
 * Create or edit a discount coupon (F-502-g). Five sections — code and
 * discount, limits, when, who, where — on one scrolling sheet.
 *
 * The rules are `coupon-form.ts`'s, which mirrors billing; an edit sends only
 * what changed (`updateBody`), and a used coupon's type and value are shown
 * disabled because billing would refuse them (F-502-c).
 */
export function CouponForm({
  me,
  coupon,
  onClose,
  onSaved,
}: {
  me: Me | null;
  coupon: AdminCoupon | null;
  onClose: () => void;
  onSaved: (notice: string) => void | Promise<void>;
}) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const errorMessage = useApiErrorMessage();
  const owner = isPlatformOwner(me);
  const frozen = coupon ? isFrozen(coupon) : false;
  const [form, setForm] = useState<Form>(() => (coupon ? formFromCoupon(coupon) : emptyCouponForm()));
  const [errors, setErrors] = useState<CouponFormErrors>({});
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [gateways, setGateways] = useState<AdminGateway[] | null>(null);

  useEffect(() => {
    billingApi.adminGateways().then(setGateways, () => setGateways([]));
  }, []);

  const requestClose = async () => {
    if (touched && !(await confirm({ title: t("common", F.confirmClose), confirmLabel: t("common", FrontendI18nKeys.common.kit.unsaved.leave) }))) return;
    onClose();
  };

  const set = <Key extends keyof Form>(k: Key, v: Form[Key]) => {
    setTouched(true);
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };
  const toggleIn = <V,>(list: V[], v: V) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const submit = async () => {
    const found = validateCouponForm(form, me, coupon);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setFailure(null);
    try {
      if (coupon) {
        const body = updateBody(form, coupon);
        if (Object.keys(body).length > 0) await billingApi.updateCoupon(coupon.id, body);
        await onSaved(t("common", K.saved));
      } else {
        const created = await billingApi.createCoupon(createBody(form, me));
        await onSaved(t("common", K.created, { code: created.code }));
      }
    } catch (e) {
      const key = refusalKey(e);
      setFailure(key ? t("common", key) : errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const field = (k: keyof Form, label: string, control: ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`cp-${k}`} className="text-xs font-bold text-text-primary">
        {label}
      </label>
      {control}
      {errors[k] ? (
        <span role="alert" className="text-[11px] font-bold text-error">
          {t("common", errors[k]!)}
        </span>
      ) : (
        hint && <span className="text-[11px] text-text-secondary">{hint}</span>
      )}
    </div>
  );
  const text = (k: keyof Form, opts: { ltr?: boolean; decimal?: boolean; disabled?: boolean; area?: boolean } = {}) =>
    opts.area ? (
      <Textarea
        id={`cp-${k}`}
        dir={opts.ltr ? "ltr" : undefined}
        rows={3}
        className="font-mono text-xs"
        aria-invalid={Boolean(errors[k])}
        value={String(form[k])}
        onChange={(e) => set(k, e.target.value as never)}
      />
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
  const chips = <V extends string | number>(values: readonly V[], selected: V[], label: (v: V) => string, onToggle: (v: V) => void) => (
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
  const section = (id: keyof typeof F.sections, children: ReactNode) => (
    <section className="flex flex-col gap-4 rounded-2xl border border-card-border p-4">
      <div>
        <h3 className="text-sm font-bold text-text-primary">{t("common", F.sections[id].title)}</h3>
        <p className="text-[11px] text-text-secondary">{t("common", F.sections[id].subtitle)}</p>
      </div>
      {children}
    </section>
  );

  const platformCoupon = coupon ? coupon.tenantId === null : owner && form.owner === "platform";
  const gatewayChoices = (gateways ?? []).filter((g) => !platformCoupon || g.source === "platform");

  return (
    <Dialog
      open
      size="lg"
      onClose={requestClose}
      title={coupon ? t("common", F.editTitle, { code: coupon.code }) : t("common", F.createTitle)}
      footer={
        <>
          {failure && (
            <p role="alert" className="me-auto text-xs font-bold text-error">
              {failure}
            </p>
          )}
          <Button variant="quiet" onClick={requestClose}>
            {t("common", F.cancel)}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={saving}
          >
            {t("common", saving ? F.saving : F.save)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {section(
            "basics",
            <>
              {owner && !coupon && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {field(
                    "owner",
                    t("common", F.owner),
                    <Select
                      id="cp-owner"
                      value={form.owner}
                      onChange={(v) => set("owner", v as Form["owner"])}
                      options={[
                        { value: "own", label: t("common", F.ownerOwn) },
                        { value: "platform", label: t("common", F.ownerPlatform) },
                        { value: "tenant", label: t("common", F.ownerTenant) },
                      ]}
                    />,
                  )}
                  {form.owner === "tenant" && field("tenantId", t("common", F.tenantId), text("tenantId", { ltr: true }))}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {field("code", t("common", F.code), text("code", { ltr: true }), t("common", F.codeHint))}
                {field("label", t("common", F.label), text("label"))}
              </div>
              {frozen && <p className="rounded-xl bg-[var(--leaf-bg)] p-2 text-[11px] text-text-secondary">{t("common", F.frozen)}</p>}
              <div className="grid gap-3 sm:grid-cols-3">
                {field(
                  "discountType",
                  t("common", F.type),
                  <Select
                    id="cp-discountType"
                    disabled={frozen}
                    value={form.discountType}
                    onChange={(v) => set("discountType", v as Form["discountType"])}
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
                      <VariantPicker
                        id="cp-grantVariantId"
                        value={form.grantVariantId}
                        onChange={(v) => set("grantVariantId", v)}
                        ownerTenant={coupon ? coupon.tenantId : variantOwnerTenant(form.owner, form.tenantId, me)}
                        invalid={Boolean(errors.grantVariantId)}
                        disabled={frozen}
                      />,
                      t("common", F.grantVariantHint),
                    )
                  : field("discountValue", t("common", F.value), text("discountValue", { ltr: true, decimal: true, disabled: frozen }))}
                {form.discountType === "percentage" && field("maxDiscountCap", t("common", F.cap), text("maxDiscountCap", { ltr: true, decimal: true }))}
              </div>
              <Toggle checked={form.isActive} onChange={(v) => set("isActive", v)} label={t("common", F.isActive)} />
              {field("note", t("common", F.note), text("note", { area: true }), t("common", F.noteHint))}
            </>,
          )}

          {section(
            "limits",
            <div className="grid gap-3 sm:grid-cols-2">
              {field("minPurchaseAmount", t("common", F.minPurchase), text("minPurchaseAmount", { ltr: true, decimal: true }))}
              {field("maxPurchaseAmount", t("common", F.maxPurchase), text("maxPurchaseAmount", { ltr: true, decimal: true }))}
              {field("totalUsageLimit", t("common", F.totalLimit), text("totalUsageLimit", { ltr: true }), t("common", F.totalLimitHint))}
              {field("perUserUsageLimit", t("common", F.perUserLimit), text("perUserUsageLimit", { ltr: true }), t("common", F.perUserHint))}
              {field("periodUsageLimit", t("common", F.periodUsageLimit), text("periodUsageLimit", { ltr: true }))}
              {field("periodDays", t("common", F.periodDays), text("periodDays", { ltr: true }))}
            </div>,
          )}

          {section(
            "schedule",
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                {field("validFrom", t("common", F.validFrom), <DatePicker value={form.validFrom} onChange={(v) => set("validFrom", v ?? "")} />)}
                {field("expiresAt", t("common", F.expiresAt), <DatePicker value={form.expiresAt} onChange={(v) => set("expiresAt", v ?? "")} />)}
              </div>
              {field(
                "activeWeekdays",
                t("common", F.weekdays),
                chips(WEEKDAYS, form.activeWeekdays as (typeof WEEKDAYS)[number][], (d) => t("common", WEEKDAY_KEYS[d]), (d) => set("activeWeekdays", toggleIn(form.activeWeekdays, d))),
                t("common", F.weekdaysHint),
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {field("activeHourFrom", t("common", F.hourFrom), text("activeHourFrom", { ltr: true }))}
                {field("activeHourTo", t("common", F.hourTo), text("activeHourTo", { ltr: true }), t("common", F.hoursHint))}
              </div>
            </>,
          )}

          {section(
            "audience",
            <>
              {field(
                "visibility",
                t("common", F.visibility),
                <Select
                  id="cp-visibility"
                  value={form.visibility}
                  onChange={(v) => set("visibility", v as Form["visibility"])}
                  options={[
                    { value: "public", label: t("common", F.public) },
                    { value: "targeted", label: t("common", F.targeted) },
                  ]}
                />,
              )}
              {form.visibility === "targeted" && field("allowedUserIds", t("common", F.userIds), text("allowedUserIds", { ltr: true, area: true }), t("common", F.userIdsHint))}
              <Toggle checked={form.firstPurchaseOnly} onChange={(v) => set("firstPurchaseOnly", v)} label={t("common", F.firstPurchaseOnly)} />
              {field("newUserWithinDays", t("common", F.newUserWithinDays), text("newUserWithinDays", { ltr: true }))}
            </>,
          )}

          {section(
            "where",
            <>
              {field(
                "allowedChannels",
                t("common", F.channels),
                chips(CHANNELS, form.allowedChannels, (c) => t("common", F.channel[c]), (c) => set("allowedChannels", toggleIn(form.allowedChannels, c))),
                t("common", F.channelsHint),
              )}
              {field(
                "gateways",
                t("common", F.gateways),
                gateways === null ? (
                  <Loader2 size={14} className="animate-spin text-primary" aria-hidden />
                ) : gatewayChoices.length === 0 ? (
                  <span className="text-[11px] text-text-secondary">{t("common", F.noGateways)}</span>
                ) : (
                  chips(
                    gatewayChoices.map((g) => `${g.source}:${g.id}`),
                    form.gateways,
                    (key) => gatewayChoices.find((g) => `${g.source}:${g.id}` === key)?.displayName ?? key,
                    (key) => set("gateways", toggleIn(form.gateways, key)),
                  )
                ),
                t("common", F.gatewaysHint),
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {field("productIds", t("common", F.productIds), text("productIds", { ltr: true, area: true }), t("common", F.scopeHint))}
                {field("variantIds", t("common", F.variantIds), text("variantIds", { ltr: true, area: true }))}
              </div>
            </>,
          )}
        </div>
    </Dialog>
  );
}
