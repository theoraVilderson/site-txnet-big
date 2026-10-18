"use client";

import { TicketPercent } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { Me } from "@/lib/auth-api";
import { billingApi } from "@/lib/billing-api";
import { COUPON_KEYS as K, createBody, emptyCouponForm, validateCouponForm } from "../_lib/coupon-form";
import { COUPON_STEPS, firstStepWithError, refusalStep, stepErrors, type CouponStep } from "../_lib/coupon-steps";
import { useCouponForm } from "../_hooks/useCouponForm";
import { Alert, Wizard, useWizard } from "../../_components/kit";
import { CouponReview } from "./CouponReview";
import { CouponStepFields } from "./CouponSections";

const F = K.form;
const W = F.wizard;

/**
 * A new coupon, one part at a time (UX-3-b, `contract.ux.md` K12): code and
 * type → limits → schedule → audience → where → review. Next checks only the
 * step's own fields (`stepErrors` over `validateCouponForm`); the review lists
 * what was set, and a refusal from billing sends the admin back to the step
 * that holds the field it names. The body is `createBody`'s, as before.
 */
export function CouponWizard({ me, onClose, onSaved }: { me: Me | null; onClose: () => void; onSaved: (notice: string) => void | Promise<void> }) {
  const { t } = useLocale();
  const { form, set, errors, setErrors, touched, saving, failure, setFailure, save } = useCouponForm(emptyCouponForm);

  const check = (step: CouponStep) => {
    const found = stepErrors(step, validateCouponForm(form, me, null));
    setErrors(found);
    return Object.keys(found).length === 0;
  };
  const wizard = useWizard({ count: COUPON_STEPS.length, validate: (i) => check(COUPON_STEPS[i]), onMove: () => setFailure(null) });
  const step = COUPON_STEPS[wizard.index];
  const goTo = (s: CouponStep) => wizard.goTo(COUPON_STEPS.indexOf(s));

  const submit = async () => {
    const found = validateCouponForm(form, me, null);
    const bad = firstStepWithError(found);
    if (bad) {
      goTo(bad);
      setErrors(found);
      return;
    }
    await save(
      async () => {
        const created = await billingApi.createCoupon(createBody(form, me));
        await onSaved(t("common", K.created, { code: created.code }));
      },
      (e) => {
        const back = refusalStep(e);
        if (back) goTo(back);
      },
    );
  };

  return (
    <Wizard
      title={t("common", F.createTitle)}
      icon={TicketPercent}
      steps={COUPON_STEPS.map((s) => ({ id: s, title: t("common", s === "review" ? W.review : F.sections[s].title), subtitle: s === "review" ? undefined : t("common", F.sections[s].subtitle) }))}
      wizard={wizard}
      dirty={touched}
      closeQuestion={t("common", F.confirmClose)}
      busy={saving}
      submitLabel={t("common", W.create)}
      onSubmit={() => void submit()}
      onClose={onClose}
      error={failure ? <Alert tone="error">{failure}</Alert> : undefined}
    >
      {step === "review" ? <CouponReview form={form} onEdit={goTo} /> : <CouponStepFields step={step} form={form} set={set} errors={errors} me={me} coupon={null} />}
    </Wizard>
  );
}
