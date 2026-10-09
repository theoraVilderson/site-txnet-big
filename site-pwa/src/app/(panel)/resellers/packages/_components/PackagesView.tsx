"use client";

import { useCallback, useEffect, useState } from "react";
import { Package, Plus, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { operatingCurrencyApi, tenantApi, type TenantPackage } from "@/lib/tenant-api";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { formatMoney } from "../../../_lib/money";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { DataTable } from "../../../_components/kit/DataTable";
import { Alert, useMessage } from "../../_components/resellers-ui";
import { RESELLER_KEYS, canAdministerResellers } from "../../_lib/resellers";
import { PACKAGE_KEYS as K, WHOLESALE_METERS, packageFormOf } from "../../_lib/packages";
import { PackageSheet } from "./PackageSheet";
import { PageHeader } from "../../../_components/kit/PageHeader";
import { Button, useConfirm } from "../../../_components/kit";

/**
 * The packages the platform sells resellers (F-118-n5, `tenant/contract.admin.md`
 * "Packages"): every one, active or withdrawn, with its prices, features and
 * wholesale VPN rate. Create and edit are one sheet; withdraw / offer again is
 * `isActive`; "apply" forces the package's features on every subscriber now.
 *
 * Who may see it is tenant-service's to decide (`platform.plan.assign` + the platform
 * owner); the check here only spares a reseller who typed the path.
 */
export function PackagesView() {
  const { lang, t } = useLocale();
  const confirm = useConfirm();
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
  const [editing, setEditing] = useState<TenantPackage | "new" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  async function act(p: TenantPackage, run: () => Promise<string>) {
    setBusy(p.id);
    setFailure(null);
    setNotice(null);
    try {
      setNotice(await run());
      reload();
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(null);
    }
  }

  const toggleActive = (p: TenantPackage) =>
    act(p, async () => {
      const saved = await tenantApi.updatePackage(p.id, { isActive: !p.isActive });
      return t("common", K.saved, { name: saved.name });
    });

  const apply = async (p: TenantPackage) => {
    if (!(await confirm({ title: t("common", K.applyConfirm), confirmLabel: t("common", K.apply) }))) return;
    return act(p, async () => {
      const answer = await tenantApi.applyPackage(p.id);
      return t("common", K.applyDone, { count: answer.subscribers });
    });
  };

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
            <Button variant="primary" size="sm" disabled={!currency} onClick={() => setEditing("new")} icon={<Plus size={14} aria-hidden />}>
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
            { id: "name", header: t("common", K.columns.name), cell: (p) => p.name, className: "font-bold text-text-primary" },
            { id: "monthly", header: t("common", K.columns.monthly), cell: (p) => money(p.monthlyPrice, p.currencyCode), dir: "ltr" },
            { id: "yearly", header: t("common", K.columns.yearly), cell: (p) => money(p.yearlyPrice, p.currencyCode), dir: "ltr" },
            { id: "rate", header: t("common", K.columns.rate), cell: rateOf, className: "text-text-secondary" },
            {
              id: "features",
              header: t("common", K.columns.features),
              cell: (p) => p.includedFeatureKeys.map((k) => ((K.features as Record<string, string>)[k] ? t("common", (K.features as Record<string, string>)[k]) : k)).join("، ") || "—",
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
            { id: "edit", label: t("common", K.edit), disabled: busy === p.id, onSelect: () => setEditing(p) },
            { id: "toggle", label: t("common", p.isActive ? K.deactivate : K.activate), disabled: busy === p.id, onSelect: () => void toggleActive(p) },
            { id: "apply", label: t("common", K.apply), disabled: busy === p.id, onSelect: () => void apply(p) },
          ]}
        />
      )}

      {editing && (
        <PackageSheet
          pkg={editing === "new" ? null : editing}
          currency={currency}
          onClose={() => setEditing(null)}
          onSaved={(p, created) => {
            setEditing(null);
            setFailure(null);
            setNotice(t("common", created ? K.created : K.saved, { name: p.name }));
            reload();
          }}
        />
      )}
    </div>
  );
}
