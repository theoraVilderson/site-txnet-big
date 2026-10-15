"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AdminGateway, ManualDestination } from "@/lib/billing-api";
import { Button, Field, Input, Toggle } from "../../../_components/kit";
import { transferKind } from "../../../_components/transfer/transfer-kinds";
import {
  destinationBody,
  destinationErrors,
  destinationFormOf,
  emptyDestinationForm,
  hasDestinationErrors,
  refusalsOf,
  type DestinationForm,
  type DestinationFormErrors,
} from "../../_lib/destination-form";
import { useGatewayMessage, type GatewaySurface } from "../../_lib/surface";

const M = FrontendI18nKeys.common.gateways.manual;

interface DestinationEditorProps {
  surface: GatewaySurface;
  gateway: AdminGateway;
  /** The row being edited, or `null` for a new one. */
  destination: ManualDestination | null;
  onSaved: () => void;
  onCancel: () => void;
}

/**
 * Add or edit one card or wallet (F-803-g): its label, the kind's own fields
 * with their live preview (`TransferKind.AdminFields`), whether it is shown,
 * and — under "advanced" — F-807's weight and daily cap. Billing checks the
 * fields by the kind and answers each refused one by name; it lands on that
 * field, not in a banner.
 */
export function DestinationEditor({ surface, gateway, destination, onSaved, onCancel }: DestinationEditorProps) {
  const { t } = useLocale();
  const errorMessage = useGatewayMessage(surface);
  const kind = transferKind(gateway.manual?.kind ?? "");
  const [form, setForm] = useState<DestinationForm>(() => (destination ? destinationFormOf(destination, kind) : emptyDestinationForm(kind)));
  const [errors, setErrors] = useState<DestinationFormErrors>({ fields: {} });
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // A checksum runs as the seller types, so a card's Luhn says why at the sixteenth digit;
  // a field still being typed is judged only on save.
  const live = Object.fromEntries(Object.entries(kind.check(form.fields)).filter(([, reason]) => reason === "checksum"));
  const fieldErrors = { ...live, ...errors.fields };

  const setField = (id: string, value: string) => {
    setForm((f) => ({ ...f, fields: { ...f.fields, [id]: value } }));
    setErrors((e) => ({ ...e, fields: { ...e.fields, [id]: undefined } }));
  };
  const set = <K extends Exclude<keyof DestinationForm, "fields">>(k: K, v: DestinationForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const found = destinationErrors(form, kind);
    setErrors(found);
    if (hasDestinationErrors(found)) {
      if (found.weight || found.dailyCapMinor) setAdvanced(true);
      return;
    }
    setSaving(true);
    setFailure(null);
    try {
      const body = destinationBody(form, kind);
      if (destination) await surface.api.updateDestination(gateway.source, gateway.id, destination.id, body);
      else await surface.api.createDestination(gateway.source, gateway.id, body);
      onSaved();
    } catch (e) {
      const refused = refusalsOf(e);
      if (refused) setErrors({ fields: refused });
      else setFailure(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Field label={t("common", M.label)} hint={t("common", M.labelHint)} error={errors.label ? t("common", M.required) : undefined}>
        <Input value={form.label} maxLength={100} onChange={(e) => set("label", e.target.value)} />
      </Field>

      <kind.AdminFields fields={form.fields} onChange={setField} errors={fieldErrors} />

      <Toggle checked={form.isActive} onChange={(v) => set("isActive", v)} label={t("common", M.shown)} hint={t("common", M.shownHint)} />

      <div className="rounded-2xl border border-card-border">
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          aria-expanded={advanced}
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-xs font-bold text-text-primary"
        >
          {t("common", M.advanced)}
          <ChevronDown size={16} className={`text-text-secondary transition-transform ${advanced ? "rotate-180" : ""}`} aria-hidden />
        </button>
        {advanced && (
          <div className="grid gap-4 border-t border-card-border p-3 sm:grid-cols-2">
            <Field label={t("common", M.weight)} hint={t("common", M.weightHint)} error={errors.weight ? t("common", M.invalidNumber) : undefined}>
              <Input dir="ltr" inputMode="numeric" value={form.weight} onChange={(e) => set("weight", e.target.value)} />
            </Field>
            <Field label={t("common", M.dailyCap)} hint={t("common", M.dailyCapHint)} optional error={errors.dailyCapMinor ? t("common", M.invalidNumber) : undefined}>
              <Input dir="ltr" inputMode="numeric" value={form.dailyCapMinor} onChange={(e) => set("dailyCapMinor", e.target.value)} />
            </Field>
          </div>
        )}
      </div>

      {failure && (
        <p role="alert" className="text-xs font-bold text-error">
          {failure}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button onClick={onCancel} disabled={saving}>
          {t("common", M.cancel)}
        </Button>
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          {t("common", saving ? M.saving : M.save)}
        </Button>
      </div>
    </div>
  );
}
