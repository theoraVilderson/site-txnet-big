"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { tenantApi, type Reseller, type ResellerBillingModel } from "@/lib/tenant-api";
import { Select } from "../../_components/kit/Select";
import { BILLING_MODELS, RESELLER_KEYS as K, createBody, emptyCreateForm, validateCreate, type CreateForm, type Errors } from "../_lib/resellers";
import { Alert, Field, Sheet, input, primaryButton, useMessage } from "./resellers-ui";

/**
 * Creating a reseller (F-018-c): a subdomain, a period and an existing user as
 * its owner. The tenant, its empty billing wallet and its subdomain address are
 * one transaction in tenant-service; nothing is charged and no trial starts
 * until the first package (`tenant/contract.admin.md`).
 */
export function CreateResellerSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (r: Reseller) => void }) {
  const { t } = useLocale();
  const message = useMessage();
  const [form, setForm] = useState<CreateForm>(emptyCreateForm);
  const [errors, setErrors] = useState<Errors<CreateForm>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<CreateForm>) => setForm((f) => ({ ...f, ...patch }));

  async function submit() {
    const found = validateCreate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      onCreated(await tenantApi.createReseller(createBody(form)));
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={t("common", K.create.title)}
      onClose={onClose}
      footer={
        <button type="button" className={primaryButton} disabled={busy} onClick={submit}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
          {t("common", K.create.submit)}
        </button>
      }
    >
      <Field label={t("common", K.create.slug)} hint={t("common", K.create.slugHint)} error={errors.slug}>
        <input className={input} dir="ltr" value={form.slug} onChange={(e) => set({ slug: e.target.value })} />
      </Field>
      <Field label={t("common", K.create.owner)} hint={t("common", K.create.ownerHint)} error={errors.ownerUserId}>
        <input className={input} dir="ltr" value={form.ownerUserId} onChange={(e) => set({ ownerUserId: e.target.value })} />
      </Field>
      <Field label={t("common", K.create.period)} error={errors.billingModel}>
        <Select
          value={form.billingModel}
          onChange={(v) => set({ billingModel: v as ResellerBillingModel })}
          options={BILLING_MODELS.map((m) => ({ value: m, label: t("common", K.period[m]) }))}
        />
      </Field>
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}
