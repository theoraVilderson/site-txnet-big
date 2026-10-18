"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Package, Plus, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { usePackageTexts } from "../../../_hooks/usePackageTexts";
import { operatingCurrencyApi, tenantApi, type TenantPackage } from "@/lib/tenant-api";
import { panelResellerPackagePath } from "@/lib/routes";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { formatMoney } from "../../../_lib/money";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { DataTable } from "../../../_components/kit/DataTable";
import { Alert, useMessage } from "../../_components/resellers-ui";
import { RESELLER_KEYS, canAdministerResellers } from "../../_lib/resellers";
import { PACKAGE_KEYS as K, WHOLESALE_METERS, packageFormOf } from "../../_lib/packages";
import { sellsNothing } from "../../_lib/package-page";
import { usePackageActions } from "../_hooks/usePackageActions";
import { PackageSheet } from "./PackageSheet";
import { PageHeader } from "../../../_components/kit/PageHeader";
import { Badge, Button } from "../../../_components/kit";
import { formatList } from "../../../_lib/digits";

/**
 * The packages the platform sells resellers (F-118-n5, `tenant/contract.admin.md`
 * "Packages"): every one, active or withdrawn, with its prices, features and
 * wholesale VPN rate, and a flag on one that lists no product. A package opens
 * its own page, where each section is edited (PK-1-f); create is a sheet;
 * withdraw / offer again is `isActive`; "apply" forces the package's features
 * on every subscriber now.
 *
 * Who may see it is tenant-service's to decide (`platform.plan.assign` + the platform
 * owner); the check here only spares a reseller who typed the path.
 */
export function PackagesView() {
  const { lang, t } = useLocale();
  const packageTexts = usePackageTexts();
  const router = useRouter();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const message = useMessage();
  const allowed = canAdministerResellers(me);
  const tenantId = me?.tenant?.id ?? null;

  const [rows, setRows] = useState<TenantPackage[] | null>(null);
  const [currency, setCurrency] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [loaded, setLoaded] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const { busy, notice, failure, setNotice, setFailure, toggleActive, apply } = usePackageActions(reload);

  useEffect(() => {
    if (!allowed || !tenantId) return;
    let alive = true;
    (async () => {
      try {
        const [packages, operating] = await Promise.all([tenantApi.packages(), operatingCurrencyApi.get(tenantId)]);
        if (!alive) return;
        setRows(packages);
        setCurrency(operating.code);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setRows(null);
        setError(e);
      } finally {
        if (alive) setLoaded(asked);
      }
    })();
    return () => {
      alive = false;
    };
  }, [allowed, tenantId, asked]);

  if (sessionLoading) return null;
  if (!allowed) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4 md:p-8">
        <Alert>{t("common", RESELLER_KEYS.refusals.not_platform_owner)}</Alert>
      </div>
    );
  }

  const isLoading = loaded !== asked && rows === null;
  const money = (amount: string | null, code: string) => (amount === null ? "—" : formatMoney(amount, code, { lang, t }));
  const rateOf = (p: TenantPackage) => {
    const form = packageFormOf(p);
    const lines = WHOLESALE_METERS.flatMap((m) => {
      const price = form.rates[m.meterKey];
      return price ? [t("common", m.perUnit, { price, currency: p.currencyCode })] : [];
    });
    return lines.length > 0 ? lines.join(" · ") : t("common", K.noRate);
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <PageHeader
        icon={Package}
        title={t("common", K.title)}
        tail={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            <Button variant="primary" size="sm" disabled={!currency} onClick={() => setCreating(true)} icon={<Plus size={14} aria-hidden />}>
              {t("common", K.new)}
            </Button>
          </>
        }
      />

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}
      {failure && <Alert>{failure}</Alert>}

      {isLoading ? (
        <TableSkeleton rows={4} columns={6} />
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{message(error)}</Alert>
          <Button variant="quiet" size="sm" onClick={reload} icon={<RotateCw size={12} aria-hidden />}>
            {t("common", RESELLER_KEYS.retry)}
          </Button>
        </div>
      ) : !rows || rows.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <DataTable
          label={t("common", K.title)}
          rows={rows}
          rowKey={(p) => p.id}
          minWidth="min-w-[860px]"
          rowClassName="align-top"
          columns={[
            {
              id: "name",
              header: t("common", K.columns.name),
              cell: (p) => (
                <span className="flex flex-wrap items-center gap-2">
                  <Link href={panelResellerPackagePath(p.id)} className="font-bold text-primary hover:underline">
                    {packageTexts.name(p)}
                  </Link>
                  {sellsNothing(p) && <Badge tone="warning">{t("common", K.sellsNothingBadge)}</Badge>}
                </span>
              ),
            },
            { id: "monthly", header: t("common", K.columns.monthly), cell: (p) => money(p.monthlyPrice, p.currencyCode), dir: "ltr" },
            { id: "yearly", header: t("common", K.columns.yearly), cell: (p) => money(p.yearlyPrice, p.currencyCode), dir: "ltr" },
            { id: "rate", header: t("common", K.columns.rate), cell: rateOf, className: "text-text-secondary" },
            {
              id: "features",
              header: t("common", K.columns.features),
              cell: (p) => formatList(p.includedFeatureKeys.map((k) => ((K.features as Record<string, string>)[k] ? t("common", (K.features as Record<string, string>)[k]) : k)), lang) || "—",
              className: "text-xs text-text-secondary",
              hideOnCard: true,
            },
            {
              id: "state",
              header: t("common", K.columns.state),
              cell: (p) => <span className={p.isActive ? "text-primary" : "text-text-secondary"}>{t("common", p.isActive ? K.active : K.inactive)}</span>,
              className: "text-xs font-bold",
            },
          ]}
          actions={(p) => [
            { id: "open", label: t("common", K.open), onSelect: () => router.push(panelResellerPackagePath(p.id)) },
            { id: "toggle", label: t("common", p.isActive ? K.deactivate : K.activate), disabled: busy === p.id, onSelect: () => void toggleActive(p, packageTexts.name(p)) },
            { id: "apply", label: t("common", K.apply), disabled: busy === p.id, onSelect: () => void apply(p) },
          ]}
        />
      )}

      {creating && (
        <PackageSheet
          currency={currency}
          onClose={() => setCreating(false)}
          onSaved={(p) => {
            setCreating(false);
            setFailure(null);
            setNotice(t("common", K.created, { name: packageTexts.name(p) }));
            reload();
          }}
        />
      )}
    </div>
  );
}
