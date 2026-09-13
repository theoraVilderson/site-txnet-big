"use client";

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { Me } from "@/lib/auth-api";
import { billingApi, type AdminGateway } from "@/lib/billing-api";
import { Select } from "../../_components/kit/Select";
import {
  CATEGORIES,
  FEE_MODES,
  FEE_TYPES,
  PROVIDERS,
  VERIFICATION,
  createBody,
  emptyForm,
  formFromGateway,
  isPlatformOwner,
  updateBody,
  validateForm,
  type FormErrors,
  type GatewayForm,
} from "../_lib/gateway-form";

const G = FrontendI18nKeys.common.gateways;
const F = G.form;

interface GatewayFormModalProps {
  /** `null` creates a gateway. */
  gateway: AdminGateway | null;
  me: Me | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

/** The same field look as the kit's `Select`, so a row of mixed controls reads as one form. */
const input =
  "w-full rounded-xl border border-card-border bg-[var(--bg-inner)] px-3 py-2 text-sm text-[var(--text-input)] placeholder:text-[var(--text-label)] transition-colors hover:border-[var(--accent-primary)] focus:border-[var(--accent-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-glow)]";

/**
 * Create or edit one gateway (F-102-d).
 *
 * Portaled to `document.body` for the reason `GiftCodeModal` gives: the top bar's
 * `backdrop-filter` makes it the containing block of any fixed descendant.
 *
 * **The two secret boxes are write-only.** They start empty on an edit, are
 * `type="password"` with autocomplete off, and a box left empty keeps the stored
 * value (`gateway-form.ts`). The form's state is dropped when the modal closes,
 * so a typed merchant id does not outlive the dialog it was typed into.
 */
export function GatewayFormModal({ gateway, me, onClose, onSaved }: GatewayFormModalProps) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const owner = isPlatformOwner(me);
  const [form, setForm] = useState<GatewayForm>(() => (gateway ? formFromGateway(gateway) : emptyForm("tenant")));
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const set = <K extends keyof GatewayForm>(k: K, v: GatewayForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    const found = validateForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setFailure(null);
    try {
      if (gateway) {
        const body = updateBody(gateway, form, me);
        if (Object.keys(body).length > 0) await billingApi.updateGateway(gateway.source, gateway.id, body);
      } else {
        await billingApi.createGateway(createBody(form, me));
      }
      await onSaved();
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const field = (k: keyof GatewayForm, label: string, control: ReactNode) => (
    // Keyed by the field: `field` is also called inside the secrets `.map`, and
    // a key set here covers every call site at once.
    <label key={k} className="flex flex-col gap-1 text-xs font-bold text-text-primary">
      {label}
      {control}
      {errors[k] && <span className="text-[11px] font-bold text-error">{t("common", G.errors[errors[k]!])}</span>}
    </label>
  );
  const text = (k: keyof GatewayForm, label: string, ltr = false) =>
    field(
      k,
      label,
      <input className={input} dir={ltr ? "ltr" : undefined} value={String(form[k])} onChange={(e) => set(k, e.target.value as never)} />,
    );
  const select = (k: keyof GatewayForm, label: string, options: readonly string[], allowEmpty = false) =>
    field(
      k,
      label,
      <Select
        value={String(form[k])}
        onChange={(v) => set(k, v as never)}
        ariaLabel={label}
        invalid={Boolean(errors[k])}
        placeholder={allowEmpty ? "—" : undefined}
        options={options.map((o) => ({ value: o, label: o }))}
      />,
    );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-card-border bg-card-bg p-5 shadow-xl sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-text-primary">{t("common", gateway ? F.editTitle : F.createTitle)}</h2>
          <button type="button" onClick={onClose} aria-label={t("common", F.cancel)} className="text-text-secondary">
            <X size={18} />
          </button>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {!gateway && owner && select("source", t("common", F.source), ["tenant", "platform"])}
          {!gateway && owner && form.source === "tenant" && text("tenantId", t("common", F.tenantId), true)}
          {text("displayName", t("common", F.displayName))}
          {select("providerName", t("common", F.provider), PROVIDERS, true)}
          {select("gatewayCategory", t("common", F.category), CATEGORIES, true)}
          {text("minAcceptAmount", t("common", F.minAmount), true)}
          {text("maxAcceptAmount", t("common", F.maxAmount), true)}
          {select("feeCalculationMode", t("common", F.feeMode), FEE_MODES)}
          {select("feeType", t("common", F.feeType), FEE_TYPES)}
          {text("feeValue", t("common", F.feeValue), true)}
          {text("feeFloor", t("common", F.feeFloor), true)}
          {text("feeCeiling", t("common", F.feeCeiling), true)}
          {owner && form.source === "tenant" && select("verificationStatus", t("common", F.verification), VERIFICATION, true)}
          <label className="flex items-center gap-2 text-xs font-bold text-text-primary">
            <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
            {t("common", F.isActive)}
          </label>
        </div>

        <fieldset className="mt-5 rounded-2xl border border-card-border p-4">
          <legend className="px-1 text-xs font-bold text-text-primary">{t("common", F.secrets)}</legend>
          <p className="mb-3 text-[11px] text-text-secondary">{t("common", F.secretsHint)}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["merchantId", "secretKey"] as const).map((k) =>
              field(
                k,
                t("common", G[k]),
                <input
                  className={input}
                  dir="ltr"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={form[k]}
                  onChange={(e) => set(k, e.target.value)}
                />,
              ),
            )}
          </div>
        </fieldset>

        {failure && (
          <p role="alert" className="mt-4 text-xs font-bold text-error">
            {failure}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-sm font-bold text-text-secondary">
            {t("common", F.cancel)}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void submit()}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
          >
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {t("common", saving ? F.saving : F.save)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
