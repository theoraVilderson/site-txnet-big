"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { fieldErrorsByPath } from "@/lib/api-error";
import { billingApi, type RegisteredPanel } from "@/lib/billing-api";
import {
  COUNTER_SEMANTICS,
  DRIVER_LABELS,
  DRIVER_TYPES,
  PANEL_ROLES,
  PANEL_TRANSPORTS,
  SYSTEMS_KEYS as K,
  emptyRegisterForm,
  validateRegister,
  type RegisterForm,
} from "../_lib/systems";
import { Section, useSystemsError } from "./parts";

const INPUT = "rounded-xl border border-card-border bg-card-bg px-3 py-2 text-sm text-text-primary";

/**
 * Registering a panel (F-027-ar's route). A desired-state write and nothing
 * more: the answer is always `pending`, and the connection test on the next
 * tick answers the questionnaire and accepts or refuses the panel — here,
 * never at billing time. The login goes to the vault and is not kept in this
 * component after the call.
 */
export function RegisterPanel({ onRegistered }: { onRegistered: () => Promise<void> }) {
  const { t } = useLocale();
  const message = useSystemsError();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<RegisterForm>(emptyRegisterForm);
  const [errors, setErrors] = useState<Partial<Record<keyof RegisterForm, string>>>({});
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState<RegisteredPanel | null>(null);

  const set = <F extends keyof RegisterForm>(field: F, value: RegisterForm[F]) => setForm((f) => ({ ...f, [field]: value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const checked = validateRegister(form);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setServerErrors({});
    setFailure(null);
    setBusy(true);
    try {
      const registered = await billingApi.registerPanel(checked.body);
      setForm(emptyRegisterForm());
      setOpen(false);
      setSent(registered);
      await onRegistered();
    } catch (e) {
      setServerErrors(fieldErrorsByPath(e));
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  const fieldError = (field: keyof RegisterForm) =>
    errors[field] ? t("common", errors[field]!) : serverErrors[field] ?? null;

  const field = (name: keyof RegisterForm, label: string, input: React.ReactNode, hint?: string) => (
    <label className="flex flex-col gap-1 text-xs text-text-secondary">
      {t("common", label)}
      {input}
      {hint && <span className="text-[11px]">{t("common", hint)}</span>}
      {fieldError(name) && <span className="text-error">{fieldError(name)}</span>}
    </label>
  );

  const F = K.register.field;

  return (
    <Section
      title={t("common", K.register.title)}
      hint={t("common", K.register.hint)}
      actions={
        !open && (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setSent(null);
            }}
            className="inline-flex items-center gap-1 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-text-on-accent"
          >
            <Plus size={14} aria-hidden />
            {t("common", K.register.open)}
          </button>
        )
      }
    >
      {sent && (
        <p role="status" className="text-xs font-bold text-primary">
          {t("common", K.register.sent)}
          {sent.credentials.configured && ` ${t("common", K.register.credentialsStored)}`}
          {sent.radiusSecret?.configured && ` ${t("common", K.register.radiusSecretStored)}`}
        </p>
      )}
      {open && (
        <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {field("name", F.name, <input value={form.name} maxLength={100} onChange={(e) => set("name", e.target.value)} className={INPUT} />)}
          {field("region", F.region, <input value={form.region} maxLength={50} onChange={(e) => set("region", e.target.value)} className={INPUT} />)}
          {field(
            "driverType",
            F.driverType,
            <select dir="ltr" value={form.driverType} onChange={(e) => set("driverType", e.target.value as RegisterForm["driverType"])} className={INPUT}>
              {DRIVER_TYPES.map((d) => (
                <option key={d} value={d}>
                  {DRIVER_LABELS[d]}
                </option>
              ))}
            </select>,
          )}
          {field(
            "transport",
            F.transport,
            <select value={form.transport} onChange={(e) => set("transport", e.target.value as RegisterForm["transport"])} className={INPUT}>
              {PANEL_TRANSPORTS.map((v) => (
                <option key={v} value={v}>
                  {t("common", K.register.transport[v])}
                </option>
              ))}
            </select>,
          )}
          {field("ipAddress", F.ipAddress, <input dir="ltr" value={form.ipAddress} onChange={(e) => set("ipAddress", e.target.value)} className={`${INPUT} font-mono`} />)}
          {field(
            "apiBaseUrl",
            F.apiBaseUrl,
            <input dir="ltr" value={form.apiBaseUrl} maxLength={500} onChange={(e) => set("apiBaseUrl", e.target.value)} className={`${INPUT} font-mono`} />,
            F.apiBaseUrlHint,
          )}
          {field(
            "counterSemantics",
            F.counterSemantics,
            <select value={form.counterSemantics} onChange={(e) => set("counterSemantics", e.target.value as RegisterForm["counterSemantics"])} className={INPUT}>
              {COUNTER_SEMANTICS.map((v) => (
                <option key={v} value={v}>
                  {t("common", K.register.counter[v])}
                </option>
              ))}
            </select>,
            F.counterSemanticsHint,
          )}
          {field(
            "role",
            F.role,
            <select value={form.role} onChange={(e) => set("role", e.target.value as RegisterForm["role"])} className={INPUT}>
              {PANEL_ROLES.map((v) => (
                <option key={v} value={v}>
                  {t("common", K.register.role[v])}
                </option>
              ))}
            </select>,
          )}
          {field(
            "maxRequestsPerMinute",
            F.maxRequestsPerMinute,
            <input dir="ltr" inputMode="numeric" value={form.maxRequestsPerMinute} onChange={(e) => set("maxRequestsPerMinute", e.target.value)} className={INPUT} />,
            F.maxRequestsPerMinuteHint,
          )}
          {field(
            "credentials",
            F.credentials,
            <input
              dir="ltr"
              type="password"
              autoComplete="off"
              value={form.credentials}
              maxLength={4096}
              onChange={(e) => set("credentials", e.target.value)}
              className={`${INPUT} font-mono`}
            />,
            F.credentialsHint,
          )}
          {form.transport === "push" &&
            field(
              "radiusSecret",
              F.radiusSecret,
              <input
                dir="ltr"
                type="password"
                autoComplete="off"
                value={form.radiusSecret}
                maxLength={4096}
                onChange={(e) => set("radiusSecret", e.target.value)}
                className={`${INPUT} font-mono`}
              />,
              F.radiusSecretHint,
            )}
          <p className="text-xs leading-5 text-text-secondary sm:col-span-2">{t("common", K.budget.tradeOff)}</p>
          {failure && (
            <p role="alert" className="text-xs font-bold text-error sm:col-span-2">
              {failure}
            </p>
          )}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="submit" disabled={busy} className="rounded-xl bg-primary px-4 py-2 text-xs font-bold text-text-on-accent disabled:opacity-50">
              {t("common", K.register.submit)}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-xl px-4 py-2 text-xs font-medium text-text-secondary hover:bg-leaf-bg">
              {t("common", K.register.cancel)}
            </button>
          </div>
        </form>
      )}
    </Section>
  );
}
