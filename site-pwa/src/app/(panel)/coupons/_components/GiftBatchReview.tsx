"use client";

import { useMemo } from "react";
import { Gift } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { Me } from "@/lib/auth-api";
import { isPlatformTenant } from "@/lib/tenant-type";
import { Alert, ReviewRows, type ReviewRow } from "../../_components/kit";
import { formatPlatformDay } from "../../_lib/datetime";
import { GIFT_KEYS, batchTotal, sampleGiftCodes, type GiftBatchForm } from "../_lib/gift-batch";
import { variantOwnerTenant } from "../_lib/variant-choices";
import { SHORT_ID } from "./PickedChips";
import { useVariantOptions } from "./VariantPicker";

const F = GIFT_KEYS.form;
const R = F.review;

/**
 * The batch as it will be made (UX-3-e): who owns it, how many codes, what
 * each gives and the total, its end ("never expires"), and a few codes in
 * its shape — invented, since a batch's codes are never on screen (rule 10).
 */
export function GiftBatchReview({ form, me, onEdit }: { form: GiftBatchForm; me: Me | null; onEdit: () => void }) {
  const { t, lang } = useLocale();
  const count = Number(form.count.trim());
  const samples = useMemo(() => sampleGiftCodes(form.prefix, count), [form.prefix, count]);
  const OWNERS = { own: F.ownerOwn, platform: F.ownerPlatform, tenant: F.ownerTenant } as const;

  const rows: ReviewRow[] = [[t("common", F.label), <span key="label" dir="auto">{form.label.trim()}</span>]];
  if (isPlatformTenant(me?.tenant?.type)) {
    const whose = form.owner === "tenant" ? <span dir="ltr">{form.tenantId.trim().slice(0, SHORT_ID)}</span> : t("common", OWNERS[form.owner]);
    rows.push([t("common", F.owner), whose]);
  }
  rows.push([t("common", F.count), count]);
  if (form.kind === "service") {
    rows.push([t("common", F.kindService), <ServiceName key="service" form={form} me={me} />]);
  } else {
    rows.push([t("common", F.value), <span key="value" dir="ltr">{form.value.trim()}</span>]);
  }
  rows.push([t("common", F.expiresAt), form.expiresAt ? formatPlatformDay(form.expiresAt, lang) : t("common", R.neverExpires)]);
  if (form.note.trim()) rows.push([t("common", F.note), <span key="note" dir="auto">{form.note.trim()}</span>]);

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-2xl border border-card-border p-4">
        <ReviewRows icon={Gift} title={t("common", R.batch)} editLabel={t("common", R.edit)} onEdit={onEdit} rows={rows} />
        {form.kind === "credit" && (
          <p className="mt-3 border-t border-card-border pt-3 text-sm font-bold text-text-primary">
            {t("common", R.total, { total: batchTotal(form.value, count) })}
          </p>
        )}
      </section>
      <section className="rounded-2xl border border-card-border p-4">
        <h3 className="text-xs font-bold text-text-primary">{t("common", R.samples)}</h3>
        <ul className="mt-2 flex flex-wrap gap-2" dir="ltr">
          {samples.map((code) => (
            <li key={code} className="rounded-lg bg-[var(--leaf-bg)] px-2 py-1 font-mono text-xs text-text-primary">
              {code}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-2xs text-text-secondary">{t("common", R.samplesHint)}</p>
      </section>
      <Alert tone="warning">{t("common", R.irreversible)}</Alert>
    </div>
  );
}

/** The variant a free-service batch grants, by its catalog label; its short id when the catalog cannot be read. */
function ServiceName({ form, me }: { form: GiftBatchForm; me: Me | null }) {
  const options = useVariantOptions(variantOwnerTenant(form.owner, form.tenantId, me));
  const id = form.grantVariantId.trim();
  const label = Array.isArray(options) ? options.find((o) => o.value === id)?.label : undefined;
  return label ? <span dir="auto">{label}</span> : <span dir="ltr">{id.slice(0, SHORT_ID)}</span>;
}
