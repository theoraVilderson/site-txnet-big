"use client";

import { KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AdminGateway, GatewaySecretState } from "@/lib/billing-api";
import { isManualProvider } from "@/lib/billing/manual-transfer";
import type { FormErrors, GatewayForm } from "../_lib/gateway-form";
import type { Provider } from "../_lib/gateway-wizard";
import { secretFields, takesStaticRate } from "../_lib/provider-fields";
import { Field, PROVIDER_ICONS, SecretInput, TextInput, fieldErrorText, type SetField } from "./gateway-fields";
import { ManualSettingFields } from "./manual/ManualSettingFields";

const G = FrontendI18nKeys.common.gateways;
const W = G.wizard;
const E = G.editor;

interface GatewayConnectionFieldsProps {
  gateway: AdminGateway;
  form: GatewayForm;
  set: SetField;
  errors: FormErrors;
}

/**
 * The edit screen's connection section (F-102-d): a provider's write-only
 * secrets, its static rate and callback — or, for a manual gateway, its proof
 * and window (F-803-g), which is what connects a payer to it.
 */
export function GatewayConnectionFields({ gateway, form, set, errors }: GatewayConnectionFieldsProps) {
  const { t } = useLocale();
  if (isManualProvider(form.providerName)) return <ManualSettingFields form={form} set={set} errors={errors} />;
  // A provider newer than the panel has no icon or hint here, only its fields.
  const provider = (form.providerName in PROVIDER_ICONS ? form.providerName : "") as Provider | "";
  const ProviderIcon = provider ? PROVIDER_ICONS[provider] : KeyRound;
  return (
      <div className="flex flex-col gap-4">
        {provider && (
          <div className="flex items-start gap-3 rounded-2xl border border-card-border bg-[var(--bg-inner)] p-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-card-bg text-primary">
              <ProviderIcon size={16} aria-hidden />
            </span>
            <p className="text-xs leading-6 text-text-primary">{t("common", W.providers[provider].where)}</p>
          </div>
        )}
        {takesStaticRate(form.providerName) && (
          <Field id="gw-staticRate" label={t("common", G.fields.starRate)} error={errors.staticRate} hint={t("common", G.fields.starRateHint)}>
            <TextInput id="gw-staticRate" value={form.staticRate} onChange={(v) => set("staticRate", v)} invalid={Boolean(errors.staticRate)} ltr decimal suffix="USD" />
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {/* The provider's own secrets, from the one map (F-104-f). */}
          {secretFields(form.providerName).map(({ slot: k, label }) => {
            const state = gateway.credentials?.[k];
            return (
              <div key={k} className="flex flex-col gap-2 rounded-2xl border border-card-border bg-[var(--bg-inner)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={`gw-${k}`} className="text-xs font-bold text-text-primary">
                    {t("common", G.fields[label])}
                  </label>
                  <SecretBadge state={state} />
                </div>
                <SecretInput
                  id={`gw-${k}`}
                  value={form[k]}
                  onChange={(v) => set(k, v)}
                  showLabel={t("common", W.secrets.show)}
                  hideLabel={t("common", W.secrets.hide)}
                />
                {errors[k] ? (
                  <span role="alert" className="text-2xs font-bold text-error">
                    {fieldErrorText(t, errors[k]!)}
                  </span>
                ) : (
                  <span className="text-2xs leading-5 text-text-secondary">{t("common", state?.configured ? E.keepCurrent : E.enterNew)}</span>
                )}
              </div>
            );
          })}
        </div>
        <Field id="gw-callbackUrl" label={t("common", G.callback.label)} error={errors.callbackUrl} hint={t("common", G.callback.hint)} optional>
          <TextInput
            id="gw-callbackUrl"
            value={form.callbackUrl}
            onChange={(v) => set("callbackUrl", v)}
            invalid={Boolean(errors.callbackUrl)}
            ltr
            placeholder={t("common", G.callback.placeholder)}
          />
        </Field>
      </div>
  );
}

/** Whether a secret is stored — never what it is. */
function SecretBadge({ state }: { state: GatewaySecretState | null | undefined }) {
  const { t } = useLocale();
  if (!state) {
    return <span className="rounded-full bg-card-bg px-2 py-0.5 text-3xs font-bold text-text-secondary">{t("common", G.unknown)}</span>;
  }
  return state.configured ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--leaf-bg)] px-2 py-0.5 text-3xs font-bold text-success">
      <ShieldCheck size={12} aria-hidden />
      {t("common", G.configured)}
      {state.version != null && (
        <span dir="ltr" className="font-normal opacity-80">
          v{state.version}
        </span>
      )}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--error-bg)] px-2 py-0.5 text-3xs font-bold text-error">
      <ShieldOff size={12} aria-hidden />
      {t("common", G.notConfigured)}
    </span>
  );
}
