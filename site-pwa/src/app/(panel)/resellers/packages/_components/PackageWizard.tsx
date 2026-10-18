"use client";

import { useState } from "react";
import { Loader2, PackagePlus, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { DEFAULT_LOCALE } from "@/env";
import { tenantApi, type TenantPackage } from "@/lib/tenant-api";
import { Button, Textarea, Wizard, useWizard } from "../../../_components/kit";
import { LanguageSelect, useDirOf } from "../../../catalog/_components/catalog-ui";
import { Alert, Field, useMessage } from "../../_components/resellers-ui";
import { RESELLER_KEYS } from "../../_lib/resellers";
import { PACKAGE_KEYS } from "../../_lib/packages";
import {
  DESCRIPTION_MAX,
  PACKAGE_WIZARD_STEPS,
  emptyPackageDraft,
  firstInvalidStep,
  formOfDraft,
  packageWizardBody,
  packageWizardErrors,
  refusalStep,
  type PackageWizardDraft,
  type PackageWizardStep,
} from "../../_lib/package-wizard";
import { usePackageWizardInputs } from "../_hooks/usePackageWizardInputs";
import { FeatureFields, NameField, PriceFields, RateFields } from "./PackageFields";
import { LimitsStep, ProductsStep, ReviewStep } from "./PackageWizardSteps";

const K = PACKAGE_KEYS.wizard;

/**
 * A new package, one question per step (PK-1-g, ADR-0154 (3)): name and
 * description → prices → features → products (every active platform product
 * ticked) → limits (each at the platform's value) → wholesale rates → review
 * with warnings. Each step is checked before the next, and the whole package
 * is one `POST /tenant-packages` (ADR-0154 (4)): a refusal names its field and
 * the wizard returns to the step that asks it. `currency` is the platform's,
 * which a new package is priced in (contract.reseller-packages.md rule 7).
 */
export function PackageWizard({ currency, onClose, onCreated }: { currency: string; onClose: () => void; onCreated: (p: TenantPackage) => void }) {
  const { t, availableLocales } = useLocale();
  const message = useMessage();
  const dirOf = useDirOf();
  const { inputs, error: loadError, productName, retry } = usePackageWizardInputs();
  const [initial] = useState<PackageWizardDraft>(() => emptyPackageDraft(DEFAULT_LOCALE));
  const [draft, setDraft] = useState<PackageWizardDraft>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const form = formOfDraft(draft, inputs?.products ?? []);
  const limits = inputs?.limits ?? [];
  const set = (patch: Partial<PackageWizardDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const wizard = useWizard({
    count: PACKAGE_WIZARD_STEPS.length,
    validate: (i) => {
      const at = PACKAGE_WIZARD_STEPS[i];
      // The products and limits steps ask what has not been read yet: their Next waits for it.
      if (!inputs && (at === "products" || at === "limits")) return false;
      const found = packageWizardErrors(at, form, limits);
      setErrors(found);
      return Object.keys(found).length === 0;
    },
    onMove: () => {
      setErrors({});
      setFailure(null);
    },
  });
  const step = PACKAGE_WIZARD_STEPS[wizard.index];
  const goTo = (to: PackageWizardStep) => wizard.goTo(PACKAGE_WIZARD_STEPS.indexOf(to));

  const create = async () => {
    if (!inputs) return;
    const invalid = firstInvalidStep(form, limits);
    if (invalid) {
      goTo(invalid);
      setErrors(packageWizardErrors(invalid, form, limits));
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      onCreated(await tenantApi.createPackage(packageWizardBody(form, limits)));
    } catch (e) {
      const to = refusalStep(e);
      if (to) goTo(to);
      // After the move: `onMove` clears the step's failure, and this one belongs to the step moved to.
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  const loading = (
    <div className="flex flex-wrap items-center gap-3">
      {loadError ? (
        <>
          <Alert>{message(loadError)}</Alert>
          <Button variant="quiet" size="sm" onClick={retry} icon={<RotateCw size={12} aria-hidden />}>
            {t("common", RESELLER_KEYS.retry)}
          </Button>
        </>
      ) : (
        <Loader2 size={18} className="mx-auto animate-spin text-text-secondary" aria-hidden />
      )}
    </div>
  );

  return (
    <Wizard
      title={t("common", K.title)}
      icon={PackagePlus}
      steps={PACKAGE_WIZARD_STEPS.map((s) => ({ id: s, title: t("common", K.steps[s]) }))}
      wizard={wizard}
      dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
      closeQuestion={t("common", K.confirmClose)}
      busy={busy}
      submitLabel={t("common", K.create)}
      onSubmit={() => void create()}
      onClose={onClose}
      intro={<p className="text-sm text-text-secondary">{t("common", K.intro[step])}</p>}
      error={failure}
    >
      {step === "names" && (
        <div className="flex flex-col gap-4">
          <Field label={t("common", K.sourceLang)}>
            <LanguageSelect value={draft.sourceLang} onChange={(v) => set({ sourceLang: v })} />
          </Field>
          <NameField form={form} set={set} errors={errors} dir={dirOf(draft.sourceLang)} />
          <Field label={t("common", K.description)} hint={t("common", K.descriptionHint)} error={errors.description}>
            <Textarea dir={dirOf(draft.sourceLang)} rows={3} maxLength={DESCRIPTION_MAX} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </div>
      )}
      {step === "prices" && <PriceFields form={form} set={set} errors={errors} code={currency} />}
      {step === "features" && <FeatureFields form={form} set={set} />}
      {step === "products" &&
        (inputs ? (
          <ProductsStep products={inputs.products} productName={productName} value={form.products} onChange={(products) => set({ products })} errors={errors} />
        ) : (
          loading
        ))}
      {step === "limits" && (inputs ? <LimitsStep rows={inputs.limits} value={draft.limits} onChange={(l) => set({ limits: l })} errors={errors} /> : loading)}
      {step === "rates" && <RateFields form={form} set={set} errors={errors} code={currency} others={[]} />}
      {step === "review" &&
        (inputs ? (
          <ReviewStep
            form={form}
            currency={currency}
            languageName={(code) => availableLocales.find((l) => l.code === code)?.name ?? code}
            products={inputs.products}
            productName={productName}
            limits={inputs.limits}
            goTo={goTo}
          />
        ) : (
          loading
        ))}
    </Wizard>
  );
}
