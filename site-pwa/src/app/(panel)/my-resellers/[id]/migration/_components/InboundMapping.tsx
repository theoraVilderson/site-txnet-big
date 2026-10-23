"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { MigrationRun, MigrationRunsApi } from "@/lib/billing-api";
import { MIGRATION_KEYS as K, mappingBody } from "../../../_lib/migration";
import { useMigrationMessage } from "../_hooks/useMigrationLive";
import { usePrepaidPlans } from "../_hooks/usePrepaidPlans";
import { Alert, Button, NativeSelect } from "../../../../_components/kit";

/**
 * Each source inbound — a router's profile, read in place (F-1601-c) — to
 * one of the reseller's prepaid plans, or none (F-201-f; entitlement
 * `contract.import.md` rules 7 and 10). The plans are
 * the users-admin door's catalog — the one the issue form reads — so no
 * `catalog.manage` is needed. Saving a previewed run's mapping previews it
 * again on billing's side; a draft is previewed here, after the save.
 */
export function InboundMapping({ api, tenantId, run, onSaved }: { api: MigrationRunsApi; tenantId: string; run: MigrationRun; onSaved: (run: MigrationRun) => void }) {
  const { t } = useLocale();
  const message = useMigrationMessage();
  const { plans, error: plansError } = usePrepaidPlans(tenantId);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const failure = error !== null ? error : plansError;

  const inbounds = run.inbounds ?? [];
  // Read in place, a router's "inbound" is a profile its users were sold, with no protocol (F-1601-c).
  const inPlace = run.sourcePanelId !== null;
  const words = inPlace
    ? { title: K.mapping.titleProfiles, intro: K.mapping.introProfiles, item: K.mapping.profile }
    : { title: K.mapping.title, intro: K.mapping.intro, item: K.mapping.inbound };
  const options = plans ?? [];
  const body = mappingBody(inbounds, chosen);
  const changed = body.some((b, i) => b.variantId !== inbounds[i].variantId);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.setInbounds(run.id, body);
      onSaved(saved.status === "draft" ? await api.preview(run.id) : saved);
      setChosen({});
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby={`mapping-${run.id}`}>
      <h3 id={`mapping-${run.id}`} className="text-sm font-bold text-text-primary">
        {t("common", words.title)}
      </h3>
      <p className="text-xs text-text-secondary">{t("common", words.intro)}</p>
      {plans !== null && options.length === 0 && <Alert tone="warning">{t("common", K.mapping.noOptions)}</Alert>}
      <ul className="divide-y divide-card-border rounded-xl border border-card-border">
        {inbounds.map((i, n) => (
          <li key={i.inboundRemoteId} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-text-primary" dir="auto">
                {t("common", words.item, { tag: i.tag || i.inboundRemoteId, protocol: i.protocol })}
              </p>
              <p className="text-xs text-text-secondary">{t("common", K.mapping.users, { count: String(i.clientCount) })}</p>
            </div>
            <NativeSelect
              className="sm:w-72"
              aria-label={t("common", K.mapping.pick)}
              value={body[n].variantId ?? ""}
              disabled={busy || plans === null}
              onChange={(e) => setChosen((c) => ({ ...c, [i.inboundRemoteId]: e.target.value }))}
            >
              <option value="">{t("common", i.clientCount > 0 ? K.mapping.pick : K.mapping.none)}</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </li>
        ))}
      </ul>
      {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
      <Button size="sm" disabled={busy || (!changed && run.status !== "draft")} onClick={() => void save()} icon={<Save size={14} aria-hidden />}>
        {t("common", busy ? K.mapping.saving : K.mapping.save)}
      </Button>
    </section>
  );
}
