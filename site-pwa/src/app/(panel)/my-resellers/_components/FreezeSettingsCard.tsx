"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { grantLimitsApi, type FreezeSettings } from "@/lib/billing-api";
import { USER_KEYS } from "../_lib/users";
import { useUserMessage } from "../[id]/users/[userId]/_components/useUserMessage";
import { Alert, Button, Checkbox } from "../../_components/kit";

const FS = USER_KEYS.freezeSettings;

/**
 * The reseller's two freeze switches (F-0401-f over F-0401-b), on the users
 * page beside the limit: whether its users may freeze their own pay-as-you-go
 * services, and whether that stops the clock. Read and saved whole — billing's
 * schema takes both or neither — and a change moves no Grant frozen already.
 */
export function FreezeSettingsCard({ tenantId }: { tenantId: string }) {
  const { t } = useLocale();
  const message = useUserMessage();
  const api = useMemo(() => grantLimitsApi(tenantId), [tenantId]);
  const [draft, setDraft] = useState<FreezeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    api.freezeSettings().then(
      (v) => live && setDraft({ selfFreezeEnabled: v.selfFreezeEnabled, selfFreezeStopsClock: v.selfFreezeStopsClock }),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const set = (patch: Partial<FreezeSettings>) => {
    setDraft((d) => d && { ...d, ...patch });
    setSaved(false);
  };
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api.setFreezeSettings(draft);
      setDraft({ selfFreezeEnabled: v.selfFreezeEnabled, selfFreezeStopsClock: v.selfFreezeStopsClock });
      setSaved(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label={t("common", FS.title)} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <div>
        <h2 className="text-sm font-bold text-text-primary">{t("common", FS.title)}</h2>
        <p className="mt-1 text-xs leading-5 text-text-secondary">{t("common", FS.hint)}</p>
      </div>
      {draft && (
        <div className="flex flex-col gap-2">
          <Checkbox checked={draft.selfFreezeEnabled} onChange={(v) => set({ selfFreezeEnabled: v })} label={t("common", FS.enabled)} />
          <Checkbox checked={draft.selfFreezeStopsClock} onChange={(v) => set({ selfFreezeStopsClock: v })} label={t("common", FS.stopsClock)} />
          <p className="text-xs text-text-secondary">{t("common", FS.stopsClockHint)}</p>
        </div>
      )}
      <Button variant="primary" size="sm" disabled={draft === null} onClick={() => void save()} loading={busy}>
        {t("common", FS.save)}
      </Button>
      {saved && <p className="text-xs font-bold text-primary">{t("common", FS.saved)}</p>}
      {error !== null && <Alert tone="error">{message(error)}</Alert>}
    </section>
  );
}
