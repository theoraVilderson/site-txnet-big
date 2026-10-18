"use client";

import { useLocale } from "@/context/LocaleContext";
import type { Me } from "@/lib/auth-api";
import { billingApi, type AdminCoupon } from "@/lib/billing-api";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { COUPON_KEYS as K, formFromCoupon, updateBody, validateCouponForm } from "../_lib/coupon-form";
import { FIELD_STEPS } from "../_lib/coupon-steps";
import { useCouponForm } from "../_hooks/useCouponForm";
import { CouponStepFields } from "./CouponSections";
import { Button, Dialog, useConfirm } from "../../_components/kit";

const F = K.form;

/**
 * Edit a discount coupon (F-502-g): the five steps of the new-coupon wizard
 * (UX-3-b) as sections of one scrolling sheet, since an edit is a change to
 * one part, not a walk through all of them.
 *
 * The rules are `coupon-form.ts`'s, which mirrors billing; an edit sends only
 * what changed (`updateBody`), and a used coupon's type and value are shown
 * disabled because billing would refuse them (F-502-c).
 */
export function CouponForm({ me, coupon, onClose, onSaved }: { me: Me | null; coupon: AdminCoupon; onClose: () => void; onSaved: (notice: string) => void | Promise<void> }) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const state = useCouponForm(() => formFromCoupon(coupon));
  const { form, set, errors, setErrors, touched, saving, failure, save } = state;

  const requestClose = async () => {
    if (touched && !(await confirm({ title: t("common", F.confirmClose), confirmLabel: t("common", FrontendI18nKeys.common.kit.unsaved.leave) }))) return;
    onClose();
  };

  const submit = async () => {
    const found = validateCouponForm(form, me, { original: coupon, currency: coupon.currencyCode });
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    await save(async () => {
      const body = updateBody(form, coupon);
      if (Object.keys(body).length > 0) await billingApi.updateCoupon(coupon.id, body);
      await onSaved(t("common", K.saved));
    });
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={requestClose}
      title={t("common", F.editTitle, { code: coupon.code })}
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
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            {t("common", saving ? F.saving : F.save)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {FIELD_STEPS.map((id) => (
          <section key={id} className="flex flex-col gap-4 rounded-2xl border border-card-border p-4">
            <div>
              <h3 className="text-sm font-bold text-text-primary">{t("common", F.sections[id].title)}</h3>
              <p className="text-2xs text-text-secondary">{t("common", F.sections[id].subtitle)}</p>
            </div>
            <CouponStepFields step={id} form={form} set={set} errors={errors} me={me} coupon={coupon} currency={coupon.currencyCode} />
          </section>
        ))}
      </div>
    </Dialog>
  );
}
