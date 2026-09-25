"use client";

import { useState, type ReactNode } from "react";
import { Globe, KeyRound, SlidersHorizontal, Tag, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { billingApi, type SystemsPanel } from "@/lib/billing-api";
import { Alert, Field, Sheet, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { addressChanged, panelEditFormOf, validatePanelEdit, type PanelEditForm } from "../_lib/panel-lifecycle";
import { SYSTEMS_KEYS as K, resubmitOutcome } from "../_lib/systems";
import { BAD, useSystemsError } from "./parts";

/**
 * Every setting of one panel in one sheet (F-027-cb -> billing F-027-by),
 * grouped as the admin thinks of them: name and region, where it is reached,
 * how hard we may poll it, and its login. Only what differs is sent
 * (`validatePanelEdit`); a changed address is warned about before the save,
 * since it re-tests the panel and pauses its collection. A new login goes to
 * its own route after the settings, and is cleared from state with the sheet.
 */
export function PanelEditSheet({ panel, onClose, onSaved }: { panel: SystemsPanel; onClose: () => void; onSaved: (sentence: string) => Promise<void> }) {
  const { t } = useLocale();
  const message = useSystemsError();
  const [form, setForm] = useState<PanelEditForm>(() => panelEditFormOf(panel));
  const [errors, setErrors] = useState<Partial<Record<keyof PanelEditForm | "form", string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const push = panel.transport === "push";
  const set = (field: keyof PanelEditForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [field]: e.target.value }));
  const error = (field: keyof PanelEditForm) => (errors[field] ? errors[field] : undefined);

  const save = async () => {
    const checked = validatePanelEdit(form, panel);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setFailure(null);
    setBusy(true);
    try {
      let sentence: string = K.edit.saved;
      if (Object.keys(checked.body).length > 0) {
        const answer = await billingApi.updatePanel(panel.id, checked.body);
        if (answer.retest) sentence = K.edit.savedRetest;
      }
      if (checked.credentials !== null) {
        const login = await billingApi.resubmitPanelLogin(panel.id, checked.credentials);
        if (sentence === K.edit.saved) sentence = resubmitOutcome(login);
      }
      await onSaved(sentence);
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={t("common", K.edit.title, { panel: panel.name })}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={quietButton}>
            {t("common", K.groups.cancel)}
          </button>
          <button type="button" disabled={busy} onClick={() => void save()} className={primaryButton}>
            {t("common", K.edit.submit)}
          </button>
        </div>
      }
    >
      <Group icon={<Tag size={14} aria-hidden />} title={t("common", K.edit.basics)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("common", K.register.field.name)} error={error("name")}>
            <input value={form.name} maxLength={100} onChange={set("name")} className={input} />
          </Field>
          <Field label={t("common", K.register.field.region)} error={error("region")}>
            <input value={form.region} maxLength={50} onChange={set("region")} className={input} />
          </Field>
        </div>
      </Group>

      <Group icon={<Globe size={14} aria-hidden />} title={t("common", K.edit.addresses)} hint={push ? t("common", K.edit.pushAddresses) : undefined}>
        {!push && (
          <>
            <Field label={t("common", K.register.field.apiBaseUrl)} error={error("apiBaseUrl")} hint={t("common", K.register.field.apiBaseUrlHint)}>
              <input dir="ltr" value={form.apiBaseUrl} maxLength={500} onChange={set("apiBaseUrl")} className={`${input} font-mono`} />
            </Field>
            <Field label={t("common", K.register.field.clientBaseUrl)} error={error("clientBaseUrl")} hint={t("common", K.register.field.clientBaseUrlHint)}>
              <input dir="ltr" value={form.clientBaseUrl} maxLength={500} onChange={set("clientBaseUrl")} className={`${input} font-mono`} />
            </Field>
          </>
        )}
        <Field label={t("common", K.register.field.ipAddress)} error={error("ipAddress")} hint={push ? t("common", K.edit.ipHint) : undefined}>
          <input dir="ltr" value={form.ipAddress} onChange={set("ipAddress")} className={`${input} font-mono`} />
        </Field>
        {addressChanged(form, panel) && (
          <p className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-5 ${BAD}`}>
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
            {t("common", K.edit.addressWarning)}
          </p>
        )}
      </Group>

      <Group icon={<SlidersHorizontal size={14} aria-hidden />} title={t("common", K.edit.budget)} hint={t("common", K.budget.tradeOff)}>
        <Field label={t("common", K.register.field.maxRequestsPerMinute)} error={error("maxRequestsPerMinute")}>
          <input dir="ltr" inputMode="numeric" value={form.maxRequestsPerMinute} onChange={set("maxRequestsPerMinute")} className={`${input} sm:max-w-40`} />
        </Field>
      </Group>

      {panel.review.reviewState !== "refused" && (
        <Group icon={<KeyRound size={14} aria-hidden />} title={t("common", K.edit.login)} hint={t("common", K.edit.loginHint)}>
          <Field label={t("common", K.register.field.credentials)} error={error("credentials")}>
            <input
              dir="ltr"
              type="password"
              autoComplete="new-password"
              value={form.credentials}
              maxLength={4096}
              onChange={set("credentials")}
              className={`${input} font-mono`}
            />
          </Field>
        </Group>
      )}

      {errors.form && <Alert>{t("common", errors.form)}</Alert>}
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}

function Group({ icon, title, hint, children }: { icon: ReactNode; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-card-border bg-bg-inner p-4">
      <div>
        <h3 className="flex items-center gap-2 text-xs font-bold text-text-primary">
          <span className="text-primary">{icon}</span>
          {title}
        </h3>
        {hint && <p className="mt-1 text-[11px] leading-5 text-text-secondary">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
