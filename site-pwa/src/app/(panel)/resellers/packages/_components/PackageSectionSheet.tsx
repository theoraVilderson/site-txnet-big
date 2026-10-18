"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { usePackageTexts } from "../../../_hooks/usePackageTexts";
import { tenantApi, type TenantPackage } from "@/lib/tenant-api";
import { Alert, Sheet, useMessage } from "../../_components/resellers-ui";
import type { Errors } from "../../_lib/resellers";
import { PACKAGE_KEYS as K, otherRates, packageFormOf, type PackageForm } from "../../_lib/packages";
import { sectionBody, sectionErrors, type PackageSection } from "../../_lib/package-page";
import { Button } from "../../../_components/kit";
import { useHoldsUnsavedEdits } from "../../../_hooks/useHoldsUnsavedEdits";
import { BasicsFields, FeatureFields, RateFields } from "./PackageFields";

const TITLES = { basics: K.page.basics, features: K.page.features, rates: K.page.rates } as const;

/**
 * One section of a package, edited over `PATCH /tenant-packages/:id` (PK-1-f):
 * `sectionBody` sends that section's fields that changed and no other, so the
 * features sheet cannot reprice a subscriber's period. A rate is history at the
 * service: a new price reaches Grants sold from now on (F-118-n2).
 */
export function PackageSectionSheet({
  pkg,
  section,
  onClose,
  onSaved,
}: {
  pkg: TenantPackage;
  section: PackageSection;
  onClose: () => void;
  onSaved: (p: TenantPackage) => void;
}) {
  const { t } = useLocale();
  const packageTexts = usePackageTexts();
  const message = useMessage();
  const [form, setForm] = useState<PackageForm>(() => packageFormOf(pkg));
  const [errors, setErrors] = useState<Errors<PackageForm>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<PackageForm>) => setForm((f) => ({ ...f, ...patch }));
  const body = sectionBody(pkg, form, section);
  // A live remount would close the sheet on what was typed (RT-1-m).
  useHoldsUnsavedEdits(body !== null);

  async function submit() {
    const found = sectionErrors(form, section);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    if (!body) {
      setFailure(t("common", K.form.nothingChanged));
      return;
    }
    setFailure(null);
    setBusy(true);
    try {
      onSaved(await tenantApi.updatePackage(pkg.id, body));
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }

  const fields = { form, set, errors, code: pkg.currencyCode };
  return (
    <Sheet
      title={t("common", K.page.sheetTitle, { section: t("common", TITLES[section]), name: packageTexts.name(pkg) })}
      onClose={onClose}
      footer={
        <Button variant="primary" size="sm" onClick={submit} loading={busy}>
          {t("common", K.form.save)}
        </Button>
      }
    >
      {section === "basics" && <BasicsFields {...fields} />}
      {section === "features" && <FeatureFields {...fields} />}
      {section === "rates" && <RateFields {...fields} others={otherRates(pkg)} />}
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}
