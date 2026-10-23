"use client";

import { useState, type FormEvent } from "react";
import { Router, Save } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { MigrationRunsApi, ResellerRouter } from "@/lib/billing-api";
import { SYSTEMS_KEYS } from "../../../../systems/_lib/systems";
import { MIGRATION_KEYS as K } from "../../../_lib/migration";
import { emptyRouterForm, routerBodyOf, routerFormErrors, routerLoginErrors, routerLoginOf, type InPlaceFamily, type RouterErrors, type RouterForm as Form } from "../../../_lib/migration-router";
import { useMigrationMessage } from "../_hooks/useMigrationLive";
import { UserPasswordFields } from "./LoginFields";
import { Alert, Button, Field, Input } from "../../../../_components/kit";

const W = SYSTEMS_KEYS.register.wizard;

/**
 * Registers one of the reseller's own routers (F-1601-g, ADR-0162), or —
 * given `router` — enters its login again. The family decides how it is
 * read; the form asks a name, the bare address and the admin login, which is
 * sent once to the vault and never shown back. Network tests it within a
 * minute and the list hears the verdict.
 */
export function RouterForm({
  api,
  family,
  router,
  onDone,
  onCancel,
}: {
  api: MigrationRunsApi;
  family: InPlaceFamily;
  /** The router whose login is entered again; none registers a new one. */
  router?: ResellerRouter;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const message = useMigrationMessage();
  const [form, setForm] = useState<Form>(emptyRouterForm);
  const [shown, setShown] = useState<RouterErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const err = (k: keyof Form) => (shown[k] ? t("common", shown[k]) : undefined);
  const idleLabel = router ? K.router.saveLogin : K.router.save;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    // A login typed again is checked alone: the name and address are the router's already.
    const errors = router ? routerLoginErrors(form, family) : routerFormErrors(form, family);
    setShown(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      if (router) await api.resubmitRouterLogin(router.id, routerLoginOf(form, family));
      else await api.registerRouter(routerBodyOf(form, family));
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-4 rounded-xl border border-card-border p-4" onSubmit={(e) => void submit(e)} noValidate>
      {!router && (
        <>
          <p className="text-sm text-text-secondary">{t("common", K.router.registerIntro)}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("common", K.router.name)} error={err("name")}>
              <Input dir="auto" autoComplete="off" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={t("common", K.router.namePlaceholder)} />
            </Field>
            <Field label={t("common", K.router.address)} hint={t("common", K.router.addressHint)} error={err("address")}>
              <Input dir="ltr" inputMode="url" autoComplete="off" value={form.address} onChange={(e) => set({ address: e.target.value })} />
            </Field>
          </div>
        </>
      )}
      <UserPasswordFields parts={form} onChange={set} errorOf={err} />
      <p className="text-xs text-text-secondary">{t("common", W.login.safe)}</p>
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy} icon={router ? <Save size={14} aria-hidden /> : <Router size={14} aria-hidden />}>
          {t("common", busy ? K.router.saving : idleLabel)}
        </Button>
        <Button type="button" size="sm" variant="quiet" disabled={busy} onClick={onCancel}>
          {t("common", K.back)}
        </Button>
      </div>
    </form>
  );
}
