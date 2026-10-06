"use client";

import { useLocale } from "@/context/LocaleContext";
import type { EvictOrphans, EvictPreview } from "@/lib/billing-api";
import { Alert, RadioCards } from "../../_components/kit";
import { needsOrphanChoice, ORPHAN_CHOICES } from "../_lib/panel-groups";
import { SYSTEMS_KEYS } from "../_lib/systems";

const K = SYSTEMS_KEYS.groups.evict;

const LABELS: Record<EvictOrphans, { label: string; hint: string }> = {
  pause: { label: K.pause, hint: K.pauseHint },
  refund: { label: K.refund, hint: K.refundHint },
};

/**
 * What taking a panel out now costs, read before the confirm (F-027-eh): the
 * configs that go and, when someone is left with no line, the owner's choice
 * for them — paused until a panel joins (recommended, first) or cancelled
 * with the unused share refunded (billing `EvictOrphans`). `safe` is the
 * sentence when no one is cut off.
 */
export function OrphanChoice({ preview, value, onChange, safe }: { preview: EvictPreview; value: EvictOrphans; onChange: (v: EvictOrphans) => void; safe: string }) {
  const { t } = useLocale();
  if (!needsOrphanChoice(preview)) return <Alert tone="info">{t("common", safe, { configs: preview.liveConfigs })}</Alert>;
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="error">{t("common", K.preview, { configs: preview.liveConfigs, users: preview.soleLineGrants })}</Alert>
      <p className="text-xs font-bold text-text-primary">{t("common", K.choice)}</p>
      <RadioCards<EvictOrphans>
        ariaLabel={t("common", K.choice)}
        columns={1}
        value={value}
        onChange={onChange}
        options={ORPHAN_CHOICES.map((v) => ({ value: v, label: t("common", LABELS[v].label), description: t("common", LABELS[v].hint) }))}
      />
    </div>
  );
}
