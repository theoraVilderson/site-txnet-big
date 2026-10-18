"use client";

import { useState, type ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { Me } from "@/lib/auth-api";
import { billingApi, type GiftBatch } from "@/lib/billing-api";
import { isPlatformTenant } from "@/lib/tenant-type";
import { DatePicker } from "../../_components/kit/DatePicker";
import { Select } from "../../_components/kit/Select";
import { Button, Dialog, Input, Textarea } from "../../_components/kit";
import { refusalKey } from "../_lib/coupon-form";
import { GIFT_KEYS as G, emptyGiftBatchForm, giftBatchBody, validateGiftBatch, type GiftBatchErrors, type GiftBatchForm } from "../_lib/gift-batch";
import { variantOwnerTenant } from "../_lib/variant-choices";
import { GiftBatchReview } from "./GiftBatchReview";
import { ResellerPicker } from "./ResellerPicker";
import { VariantPicker } from "./VariantPicker";

const F = G.form;

/**
 * Generate a gift-code batch (F-502-h): the form, then a review inside the
 * same sheet (UX-3-e) — a batch cannot be undone, so the codes are made only
 * from the review's own button. Eight fields need no wizard.
 */
export function GiftBatchSheet({ me, onClose, onCreated }: { me: Me | null; onClose: () => void; onCreated: (b: GiftBatch) => void | Promise<void> }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const owner = isPlatformTenant(me?.tenant?.type);
  const [form, setForm] = useState<GiftBatchForm>(emptyGiftBatchForm);
  const [errors, setErrors] = useState<GiftBatchErrors>({});
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const set = <K extends keyof GiftBatchForm>(k: K, v: GiftBatchForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const review = () => {
    const found = validateGiftBatch(form, me);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length === 0) setReviewing(true);
  };

  const generate = async () => {
    setSaving(true);
    setFailure(null);
    try {
      await onCreated(await billingApi.generateGiftBatch(giftBatchBody(form, me)));
    } catch (e) {
      const key = refusalKey(e);
      setFailure(key ? t("common", key) : errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const field = (k: keyof GiftBatchForm, label: string, control: ReactNode, hint?: string) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`gb-${k}`} className="text-xs font-bold text-text-primary">
        {label}
      </label>
      {control}
      {errors[k] ? (
        <span role="alert" className="text-2xs font-bold text-error">
          {t("common", errors[k])}
        </span>
      ) : (
        hint && <span className="text-2xs text-text-secondary">{hint}</span>
      )}
    </div>
  );
  const text = (k: keyof GiftBatchForm, opts: { ltr?: boolean; area?: boolean } = {}) =>
    opts.area ? (
      <Textarea id={`gb-${k}`} dir={opts.ltr ? "ltr" : undefined} rows={3} className="font-mono text-xs" aria-invalid={Boolean(errors[k])} value={form[k]} onChange={(e) => set(k, e.target.value)} />
    ) : (
      <Input id={`gb-${k}`} dir={opts.ltr ? "ltr" : undefined} aria-invalid={Boolean(errors[k])} value={form[k]} onChange={(e) => set(k, e.target.value)} />
    );

  const footer = (
    <>
      {failure && (
        <p role="alert" className="me-auto text-xs font-bold text-error">
          {failure}
        </p>
      )}
      {reviewing ? (
        <>
          <Button variant="quiet" onClick={() => setReviewing(false)} disabled={saving}>
            {t("common", F.review.back)}
          </Button>
          <Button variant="primary" onClick={() => void generate()} loading={saving}>
            {t("common", saving ? F.submitting : F.review.confirm, { count: form.count.trim() })}
          </Button>
        </>
      ) : (
        <>
          <Button variant="quiet" onClick={onClose}>
            {t("common", F.cancel)}
          </Button>
          <Button variant="primary" onClick={review}>
            {t("common", F.review.open)}
          </Button>
        </>
      )}
    </>
  );

  return (
    <Dialog open size="md" onClose={onClose} title={t("common", reviewing ? F.review.title : F.title)} footer={footer}>
      {reviewing ? (
        <GiftBatchReview form={form} me={me} onEdit={() => setReviewing(false)} />
      ) : (
        <div className="flex flex-col gap-4">
          {owner && (
            <div className="grid gap-3 sm:grid-cols-2">
              {field(
                "owner",
                t("common", F.owner),
                <Select
                  id="gb-owner"
                  value={form.owner}
                  onChange={(v) => set("owner", v as GiftBatchForm["owner"])}
                  options={[
                    { value: "own", label: t("common", F.ownerOwn) },
                    { value: "platform", label: t("common", F.ownerPlatform) },
                    { value: "tenant", label: t("common", F.ownerTenant) },
                  ]}
                />,
              )}
              {form.owner === "tenant" && (
                <div className="sm:col-span-2">
                  {field("tenantId", t("common", F.tenantId), <ResellerPicker id="gb-tenantId" value={form.tenantId} onChange={(v) => set("tenantId", v)} invalid={Boolean(errors.tenantId)} />)}
                </div>
              )}
            </div>
          )}
          {field("label", t("common", F.label), text("label"))}
          <div className="grid gap-3 sm:grid-cols-2">
            {field("count", t("common", F.count), text("count", { ltr: true }), t("common", F.countHint))}
            {field(
              "kind",
              t("common", F.kind),
              <Select
                id="gb-kind"
                value={form.kind}
                onChange={(v) => set("kind", v as typeof form.kind)}
                options={[
                  { value: "credit", label: t("common", F.kindCredit) },
                  { value: "service", label: t("common", F.kindService) },
                ]}
              />,
            )}
            {form.kind === "service"
              ? field(
                  "grantVariantId",
                  t("common", F.grantVariantId),
                  <VariantPicker
                    id="gb-grantVariantId"
                    value={form.grantVariantId}
                    onChange={(v) => set("grantVariantId", v)}
                    ownerTenant={variantOwnerTenant(form.owner, form.tenantId, me)}
                    invalid={Boolean(errors.grantVariantId)}
                  />,
                  t("common", F.grantVariantHint),
                )
              : field("value", t("common", F.value), text("value", { ltr: true }))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field("prefix", t("common", F.prefix), text("prefix", { ltr: true }), t("common", F.prefixHint))}
            {field("expiresAt", t("common", F.expiresAt), <DatePicker value={form.expiresAt} onChange={(v) => set("expiresAt", v ?? "")} />)}
          </div>
          {field("note", t("common", F.note), text("note", { area: true }))}
        </div>
      )}
    </Dialog>
  );
}
