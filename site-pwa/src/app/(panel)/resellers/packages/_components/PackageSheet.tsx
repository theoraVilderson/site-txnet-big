"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { tenantApi, type TenantPackage } from "@/lib/tenant-api";
import { Alert, Sheet, useMessage } from "../../_components/resellers-ui";
import type { Errors } from "../../_lib/resellers";
import { PACKAGE_KEYS as K, createPackageBody, emptyPackageForm, validatePackage, type PackageForm } from "../../_lib/packages";
import { Button } from "../../../_components/kit";
import { useHoldsUnsavedEdits } from "../../../_hooks/useHoldsUnsavedEdits";
import { BasicsFields, FeatureFields, RateFields } from "./PackageFields";

/**
 * Creating one package (F-018-d, F-118-n5): name, the two prices, the features
 * it includes and the wholesale prices — per GiB of VPN traffic (F-118-n1),
 * and an unlimited plan's flat price per 30 days (F-118-aa). `currency` is the
 * platform's: a new package is priced in it. Editing is the package's page,
 * one sheet per section (PK-1-f); this sheet gives way to the wizard (PK-1-g).
 */
export function PackageSheet({ currency, onClose, onSaved }: { currency: string; onClose: () => void; onSaved: (p: TenantPackage) => void }) {
  const { t } = useLocale();
  const message = useMessage();
  const [form, setForm] = useState<PackageForm>(emptyPackageForm);
  const [errors, setErrors] = useState<Errors<PackageForm>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PackageForm>) => setForm((f) => ({ ...f, ...patch }));
  // A live remount would close the sheet on what was typed (RT-1-m).
  useHoldsUnsavedEdits(JSON.stringify(form) !== JSON.stringify(emptyPackageForm()));

  async function submit() {
    const found = validatePackage(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setFailure(null);
    setBusy(true);
    try {
      onSaved(await tenantApi.createPackage(createPackageBody(form)));
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={t("common", K.form.createTitle)}
      onClose={onClose}
      footer={
        <Button variant="primary" size="sm" onClick={submit} loading={busy}>
          {t("common", K.form.submit)}
        </Button>
      }
    >
      <BasicsFields form={form} set={set} errors={errors} code={currency} />
      <FeatureFields form={form} set={set} />
      <RateFields form={form} set={set} errors={errors} code={currency} others={[]} />
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}
