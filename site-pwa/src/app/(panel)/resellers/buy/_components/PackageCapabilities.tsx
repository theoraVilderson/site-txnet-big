"use client";

import { Check, Minus } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { PackageOffer } from "@/lib/tenant-api";
import { DataTable } from "../../../_components/kit/DataTable";
import { usePackageTexts } from "../../../_hooks/usePackageTexts";
import { PACKAGE_KEYS } from "../../_lib/packages";
import { PURCHASE_KEYS as K, RESELLER_BASICS, featureChart } from "../../_lib/purchase";

/**
 * Everything a reseller can do, before the buyer pays (user, 2026-10-06): the
 * picked package's description in the buyer's language (ADR-0154 (7)), what
 * every package gives, then every feature a package may carry against the
 * packages on sale for this period, the picked one marked. Words, never keys.
 */
export function Capabilities({ offers, pickedId }: { offers: PackageOffer[]; pickedId: string }) {
  const { t } = useLocale();
  const packages = usePackageTexts(offers.map((o) => o.sourceLang));
  const features = PACKAGE_KEYS.features as Record<string, string>;
  const picked = offers.find((o) => o.id === pickedId);
  const description = picked ? packages.description(picked) : null;
  return (
    <div className="space-y-4">
      {description && <p className="whitespace-pre-line text-sm text-text-secondary">{description}</p>}
      <div>
        <p className="text-xs font-bold text-text-secondary">{t("common", K.everyPackage)}</p>
        <ul className="mt-2 grid gap-1.5 text-sm text-text-primary sm:grid-cols-2">
          {RESELLER_BASICS.map((k) => (
            <li key={k} className="flex items-center gap-2">
              <Check size={14} className="shrink-0 text-primary" aria-hidden />
              {t("common", K.basics[k])}
            </li>
          ))}
        </ul>
      </div>
      {offers.length > 0 && (
        <div>
          <p className="text-xs font-bold text-text-secondary">{t("common", K.features)}</p>
          <div className="mt-2">
            <DataTable
              label={t("common", K.features)}
              compact
              bare
              rows={featureChart(offers)}
              rowKey={(row) => row.key}
              columns={[
                {
                  id: "feature",
                  header: t("common", K.feature),
                  cell: (row) => (features[row.key] ? t("common", features[row.key]) : row.key),
                  className: "text-text-primary",
                },
                ...offers.map((o, i) => ({
                  id: o.id,
                  header: <span className={o.id === pickedId ? "text-primary" : undefined}>{packages.name(o)}</span>,
                  cell: (row: { included: boolean[] }) =>
                    row.included[i] ? (
                      <Check size={16} className="text-primary" aria-label={t("common", K.has)} />
                    ) : (
                      <Minus size={16} className="text-text-secondary" aria-label={t("common", K.hasNot)} />
                    ),
                  className: o.id === pickedId ? "bg-primary/5" : undefined,
                })),
              ]}
            />
          </div>
        </div>
      )}
    </div>
  );
}
