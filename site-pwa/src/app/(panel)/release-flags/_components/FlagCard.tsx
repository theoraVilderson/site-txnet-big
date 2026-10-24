"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { RELEASE_FLAG_STAGES, releaseFlagsApi, type ReleaseFlagRow, type ReleaseFlagStage } from "@/lib/release-flags-api";
import type { Reseller } from "@/lib/tenant-api";
import { Badge, Button, Card, CardHeader, Field, NativeSelect, SegmentedControl, notify } from "../../_components/kit";
import { FLAG_KEYS as K, resellersWithoutException } from "../_lib/release-flags";

/**
 * One flag: who has it (the stage), the resellers with their own answer, and
 * a reseller added on or off. Each change is saved at once and the table read
 * again (`onSaved`); a refusal is shown and nothing changes on screen.
 */
export function FlagCard({ flag, resellers, onSaved }: { flag: ReleaseFlagRow; resellers: readonly Reseller[]; onSaved: () => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState("");
  const slugOf = (id: string) => resellers.find((r) => r.id === id)?.slug ?? t("common", K.unknownReseller);
  const available = resellersWithoutException(flag, resellers);

  const save = async (write: () => Promise<void>) => {
    setBusy(true);
    try {
      await write();
      notify.success(t("common", K.saved));
      setPicked("");
      onSaved();
    } catch (e) {
      notify.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const stageOptions = RELEASE_FLAG_STAGES.map((stage) => ({ value: stage, label: t("common", K.stage[stage]), disabled: busy }));
  return (
    <Card>
      <CardHeader title={<code dir="ltr">{flag.key}</code>} />
      <p className="mb-2 text-sm font-semibold text-text-primary">{t("common", K.whoHasIt)}</p>
      <SegmentedControl<ReleaseFlagStage>
        value={flag.stage}
        options={stageOptions}
        ariaLabel={t("common", K.whoHasIt)}
        onChange={(stage) => save(() => releaseFlagsApi.setStage(flag.key, stage))}
        className="flex-wrap"
      />

      <p className="mt-5 text-sm font-semibold text-text-primary">{t("common", K.exceptionsTitle)}</p>
      <p className="mb-2 text-xs text-text-secondary">{t("common", K.exceptionsHint)}</p>
      {flag.exceptions.length === 0 && <p className="text-sm text-text-secondary">{t("common", K.noExceptions)}</p>}
      <ul className="flex flex-col gap-2">
        {flag.exceptions.map((e) => (
          <li key={e.tenantId} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm text-text-primary">{slugOf(e.tenantId)}</span>
            <Badge tone={e.isOn ? "success" : "neutral"}>{t("common", e.isOn ? K.on : K.off)}</Badge>
            <Button size="sm" variant="quiet" disabled={busy} onClick={() => save(() => releaseFlagsApi.setException(flag.key, e.tenantId, !e.isOn))}>
              {t("common", e.isOn ? K.addOff : K.addOn)}
            </Button>
            <Button size="sm" variant="quiet" disabled={busy} icon={<Trash2 size={14} aria-hidden />} onClick={() => save(() => releaseFlagsApi.clearException(flag.key, e.tenantId))}>
              {t("common", K.remove)}
            </Button>
          </li>
        ))}
      </ul>

      {available.length > 0 && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <Field label={t("common", K.chooseReseller)} className="min-w-48 flex-1">
            <NativeSelect value={picked} onChange={(e) => setPicked(e.target.value)} disabled={busy}>
              <option value="">{t("common", K.chooseReseller)}</option>
              {available.map((r) => (
                <option key={r.id} value={r.id}>{r.slug}</option>
              ))}
            </NativeSelect>
          </Field>
          <Button size="sm" variant="primary" disabled={!picked || busy} onClick={() => save(() => releaseFlagsApi.setException(flag.key, picked, true))}>
            {t("common", K.addOn)}
          </Button>
          <Button size="sm" disabled={!picked || busy} onClick={() => save(() => releaseFlagsApi.setException(flag.key, picked, false))}>
            {t("common", K.addOff)}
          </Button>
        </div>
      )}
    </Card>
  );
}
