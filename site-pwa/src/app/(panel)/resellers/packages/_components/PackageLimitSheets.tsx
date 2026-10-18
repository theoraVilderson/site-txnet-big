"use client";

import { useLocale } from "@/context/LocaleContext";
import { resellerLimitsApi, type ResellerLimitKey } from "@/lib/tenant-api";
import { Alert, Sheet } from "../../_components/resellers-ui";
import { useOneWrite } from "../../_hooks/useOneWrite";
import { LIMIT_KEYS } from "../../_lib/limits";
import { PACKAGE_KEYS as K } from "../../_lib/packages";
import type { PackageLimit } from "../../_lib/package-page";
import { useHeld, ValueEditor } from "../../limits/_components/LimitsView";
import { OverageEditor, useOverageHeld } from "../../limits/_components/QuotaOverage";

type SheetProps = { packageId: string; packageName: string; limits: PackageLimit[]; onClose: () => void; onSaved: () => void };

/** A limit's name in the registry's words. */
export function useLimitName() {
  const { t } = useLocale();
  return (key: ResellerLimitKey) => t("common", (LIMIT_KEYS.keys as Record<ResellerLimitKey, { name: string }>)[key].name);
}

/**
 * The package level of every registry key (ADR-0106), each beside the
 * platform's value: a number, "no limit", or back to the platform's. The same
 * routes as `/resellers/limits`; the levels resolve at tenant-service.
 */
export function PackageLimitsSheet({ packageId, packageName, limits, onClose, onSaved }: SheetProps) {
  const { t } = useLocale();
  const held = useHeld();
  const limitName = useLimitName();
  const { busy, failure, run } = useOneWrite(onSaved);
  return (
    <Sheet title={t("common", K.page.sheetTitle, { section: t("common", K.page.limits), name: packageName })} onClose={onClose}>
      <p className="text-xs leading-5 text-text-secondary">{t("common", K.page.limitsHint)}</p>
      {limits.map((l) => (
        <div key={l.key} className="space-y-1 border-t border-card-border pt-3">
          <p className="text-sm font-bold text-text-primary">{limitName(l.key)}</p>
          <p className="text-xs text-text-secondary">
            {t("common", K.page.own, { value: held(l.own) })} · {t("common", K.page.platform, { value: held(l.platform) })}
          </p>
          <ValueEditor
            label={limitName(l.key)}
            max={l.max}
            busy={busy}
            onSave={(v) => run(() => resellerLimitsApi.setPackage(packageId, l.key, v))}
            onClear={l.own !== undefined ? () => run(() => resellerLimitsApi.clearPackage(packageId, l.key)) : undefined}
          />
        </div>
      ))}
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}

/** What this package does past each quota (ADR-0107 point 2), beside the platform's answer; a guard is never sold past. */
export function PackageOverageSheet({ packageId, packageName, limits, onClose, onSaved }: SheetProps) {
  const { t } = useLocale();
  const held = useOverageHeld();
  const limitName = useLimitName();
  const { busy, failure, run } = useOneWrite(onSaved);
  return (
    <Sheet title={t("common", K.page.sheetTitle, { section: t("common", K.page.overage), name: packageName })} onClose={onClose}>
      <p className="text-xs leading-5 text-text-secondary">{t("common", K.page.overageHint)}</p>
      {limits.flatMap((l) =>
        l.overage
          ? [
              <div key={l.key} className="space-y-1 border-t border-card-border pt-3">
                <p className="text-sm font-bold text-text-primary">{limitName(l.key)}</p>
                <p className="text-xs text-text-secondary">
                  {t("common", K.page.own, { value: held(l.overage.own) })} · {t("common", K.page.platform, { value: held(l.overage.platform ?? undefined) })}
                </p>
                <OverageEditor
                  label={limitName(l.key)}
                  busy={busy}
                  onSave={(body) => run(() => resellerLimitsApi.setPackageOverage(packageId, l.key, body))}
                  onClear={l.overage.own ? () => run(() => resellerLimitsApi.clearPackageOverage(packageId, l.key)) : undefined}
                />
              </div>,
            ]
          : [],
      )}
      {failure && <Alert>{failure}</Alert>}
    </Sheet>
  );
}
