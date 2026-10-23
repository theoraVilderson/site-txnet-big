"use client";

import { useState, type FormEvent } from "react";
import { PlugZap } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { MigrationRun, MigrationRunsApi } from "@/lib/billing-api";
import { DRIVER_LABELS, SYSTEMS_KEYS } from "../../../../systems/_lib/systems";
import {
  IMPORT_FAMILIES,
  MIGRATION_KEYS as K,
  connectFormErrors,
  emptyConnectForm,
  loginKindOfFamily,
  sourceLoginOf,
  type ConnectErrors,
  type ConnectForm,
  type ImportFamily,
} from "../../../_lib/migration";
import { isInPlaceFamily } from "../../../_lib/migration-router";
import { useMigrationMessage } from "../_hooks/useMigrationLive";
import { UserPasswordFields } from "./LoginFields";
import { RouterPicker } from "./RouterPicker";
import { Alert, Button, Field, Input, NativeSelect, PasswordInput } from "../../../../_components/kit";

const W = SYSTEMS_KEYS.register.wizard;

/**
 * Connect to the old panel (F-201-f): its family, its address and the admin
 * login, then the first read — the preview is the connection's test, and a
 * refusal comes back on the run as its `failureReason`. With no `run` it
 * starts one; with one (a login refused, or past its 7 days) it stores the
 * login again for that run's panel. The login is sent once to the vault and
 * never shown back (tenant `contract.source-login.md` rule 3). A family read
 * in place asks for none: it is read from the reseller's own router
 * (`RouterPicker`, F-1601-c).
 */
export function SourceLoginForm({
  api,
  tenantId,
  run,
  family: fixed,
  onDone,
  onCancel,
}: {
  api: MigrationRunsApi;
  tenantId: string;
  run: MigrationRun | null;
  /** The run's family, when there is one: a run reads one panel. */
  family?: ImportFamily;
  onDone: (run: MigrationRun) => void;
  onCancel?: () => void;
}) {
  const { t } = useLocale();
  const message = useMigrationMessage();
  const [form, setForm] = useState<ConnectForm>(() => ({ ...emptyConnectForm(fixed), address: run?.sourceAddress ?? "" }));
  const [shown, setShown] = useState<ConnectErrors>({});
  // A run created before a later step failed: a retry stores its login, never a second run.
  const [created, setCreated] = useState<MigrationRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const kind = loginKindOfFamily(form.family);
  const set = (patch: Partial<ConnectForm>) => setForm((f) => ({ ...f, ...patch }));
  const err = (k: keyof ConnectForm) => {
    const key = shown[k];
    return key ? t("common", key, { origin: run?.sourceAddress ?? "" }) : undefined;
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const errors = connectFormErrors(form, run ?? created);
    setShown(errors);
    if (Object.keys(errors).length > 0) return;
    const { sourceAddress, login } = sourceLoginOf(form);
    setBusy(true);
    setError(null);
    try {
      let target = run ?? created;
      if (!target) {
        target = await api.create({ family: form.family, sourceAddress });
        setCreated(target);
      }
      await api.storeLogin(target.id, login);
      onDone(await api.preview(target.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const familyField = (
    <Field label={t("common", K.family)}>
      <NativeSelect value={form.family} disabled={fixed !== undefined || created !== null} onChange={(e) => set({ family: e.target.value as ImportFamily })}>
        {IMPORT_FAMILIES.map((f) => (
          <option key={f} value={f}>
            {DRIVER_LABELS[f]}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
  if (isInPlaceFamily(form.family))
    return (
      <div className="space-y-4">
        {familyField}
        <RouterPicker api={api} tenantId={tenantId} family={form.family} onDone={onDone} onCancel={onCancel} />
      </div>
    );

  return (
    <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
      <p className="text-sm text-text-secondary">{t("common", run ? K.loginAgain : K.loginIntro)}</p>
      {familyField}
      <Field label={t("common", K.address)} hint={t("common", form.family === "hiddify" ? W.apiBaseUrlHint.hiddify : W.apiBaseUrlHint.default)} error={err("address")}>
        <Input dir="ltr" inputMode="url" autoComplete="off" value={form.address} onChange={(e) => set({ address: e.target.value })} placeholder={t("common", W.placeholder.apiBaseUrl)} />
      </Field>
      <Field label={t("common", K.clientBaseUrl)} hint={t("common", K.clientBaseUrlHint)} error={err("clientBaseUrl")} optional>
        <Input dir="ltr" inputMode="url" autoComplete="off" value={form.clientBaseUrl} onChange={(e) => set({ clientBaseUrl: e.target.value })} placeholder={t("common", W.placeholder.clientBaseUrl)} />
      </Field>
      {kind === "apiKey" ? (
        <Field label={t("common", W.login.apiKey)} hint={t("common", W.login.apiKeyHint)} error={err("apiKey")}>
          <PasswordInput dir="ltr" autoComplete="off" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
        </Field>
      ) : (
        <UserPasswordFields parts={form} onChange={set} errorOf={err} />
      )}
      <p className="text-xs text-text-secondary">{t("common", W.login.safe)}</p>
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy} icon={<PlugZap size={14} aria-hidden />}>
          {t("common", busy ? K.connecting : K.connect)}
        </Button>
        {onCancel && (
          <Button type="button" variant="quiet" disabled={busy} onClick={onCancel}>
            {t("common", K.back)}
          </Button>
        )}
      </div>
    </form>
  );
}
