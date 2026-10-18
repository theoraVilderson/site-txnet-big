"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { refusalKey, type CouponForm, type CouponFormErrors } from "../_lib/coupon-form";
import type { SetCouponField } from "../_components/coupon-fields-ui";

/**
 * The coupon form's state, shared by the new-coupon wizard and the edit sheet
 * (UX-3-b): the form, its errors (a field's clears when it changes), whether
 * anything was touched, the save in flight and billing's refusal as a sentence.
 */
export function useCouponForm(initial: () => CouponForm) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [form, setForm] = useState<CouponForm>(initial);
  const [errors, setErrors] = useState<CouponFormErrors>({});
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const set: SetCouponField = (k, v) => {
    setTouched(true);
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  /** Run a save: `saving` while it runs, and a refusal kept as its sentence (`REFUSAL_KEYS`, else the API's). */
  const save = async (run: () => Promise<void>, onRefused?: (e: unknown) => void) => {
    setSaving(true);
    setFailure(null);
    try {
      await run();
    } catch (e) {
      // Before the sentence: a step change clears the failure it leaves behind.
      onRefused?.(e);
      const key = refusalKey(e);
      setFailure(key ? t("common", key) : errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return { form, set, errors, setErrors, touched, saving, failure, setFailure, save };
}
