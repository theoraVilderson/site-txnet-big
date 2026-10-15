"use client";

import { UserCheck } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { WINDOW_MINUTES } from "@/lib/billing/manual-transfer";
import { Checkbox } from "../../../_components/kit";
import { transferKind } from "../../../_components/transfer/transfer-kinds";
import type { FormErrors, GatewayForm } from "../../_lib/gateway-form";
import { Field, TextInput, type SetField } from "../gateway-fields";

const M = FrontendI18nKeys.common.gateways.manual;
const T = FrontendI18nKeys.common.transfer;

/**
 * A manual gateway's own settings (F-803-g), the same in the add wizard and
 * the edit screen: the proof the payer must send, ticked from the kind's
 * fields — at least one — and the payer's window.
 *
 * The confirmation mode has no control: it is drawn only once a kind or
 * network has a watcher (F-803-f), and until then every manual gateway is
 * confirmed by a person, which is said here instead.
 */
export function ManualSettingFields({ form, set, errors }: { form: GatewayForm; set: SetField; errors: FormErrors }) {
  const { t } = useLocale();
  const kind = transferKind(form.manualKind);
  // A kind newer than the panel names its proof as billing stored it.
  const proofIds = kind.proofFields.length > 0 ? kind.proofFields : form.requiredProof;
  const toggle = (id: string, on: boolean) =>
    set("requiredProof", on ? [...form.requiredProof, id] : form.requiredProof.filter((p) => p !== id));

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-bold text-text-primary">{t("common", M.requiredProof)}</legend>
        <p className="text-2xs leading-5 text-text-secondary">{t("common", M.requiredProofHint)}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {proofIds.map((id) => (
            <Checkbox
              key={id}
              checked={form.requiredProof.includes(id)}
              onChange={(on) => toggle(id, on)}
              label={id in T.proof ? t("common", T.proof[id as keyof typeof T.proof]) : id}
              className="rounded-xl border border-card-border bg-[var(--bg-inner)] p-3"
            />
          ))}
        </div>
        {errors.requiredProof && (
          <span role="alert" className="text-2xs font-bold text-error">
            {t("common", M.atLeastOneProof)}
          </span>
        )}
      </fieldset>

      <Field id="gw-windowMinutes" label={t("common", M.windowMinutes)} error={errors.windowMinutes} hint={t("common", M.windowHint, { min: String(WINDOW_MINUTES.min), max: String(WINDOW_MINUTES.max) })}>
        <TextInput
          id="gw-windowMinutes"
          value={form.windowMinutes}
          onChange={(v) => set("windowMinutes", v)}
          invalid={Boolean(errors.windowMinutes)}
          ltr
          decimal
          suffix={t("common", M.minutes)}
        />
      </Field>

      <p className="flex items-start gap-2 rounded-xl bg-[var(--leaf-bg)] p-3 text-xs leading-6 text-text-primary">
        <UserCheck size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
        {t("common", M.byPersonNote)}
      </p>
    </div>
  );
}
