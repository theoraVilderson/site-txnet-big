"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Package, Plus, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { operatingCurrencyApi, tenantApi, type TenantPackage } from "@/lib/tenant-api";
import { PANEL_RESELLERS } from "@/lib/routes";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { formatMoney } from "../../../_lib/money";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { Alert, primaryButton, quietButton, useMessage } from "../../_components/resellers-ui";
import { RESELLER_KEYS, canAdministerResellers } from "../../_lib/resellers";
import { PACKAGE_KEYS as K, WHOLESALE_METERS, packageFormOf } from "../../_lib/packages";
import { PackageSheet } from "./PackageSheet";

/**
 * The packages the platform sells resellers (F-118-n5, `tenant/contract.admin.md`
 * "Packages"): every one, active or withdrawn, with its prices, features and
 * wholesale VPN rate. Create and edit are one sheet; withdraw / offer again is
 * `isActive`; "apply" forces the package's features on every subscriber now.
 *
 * Who may see it is tenant-service's to decide (`tenant.manage` + the platform
 * owner); the check here only spares a reseller who typed the path.
 */
export function PackagesView() {
  const { lang, t } = useLocale();
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

  const apply = (p: TenantPackage) => {
    if (!window.confirm(t("common", K.applyConfirm))) return;
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
  const cell = "px-3 py-2 text-start";

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <Link href={PANEL_RESELLERS} className="mb-2 inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
            <ArrowLeft size={14} aria-hidden />
            {t("common", K.back)}
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary md:text-3xl">
            <Package size={22} className="text-primary" aria-hidden />
            {t("common", K.title)}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", K.subtitle)}</p>
        </div>
        <button type="button" className={primaryButton} disabled={!currency} onClick={() => setEditing("new")}>
          <Plus size={14} aria-hidden />
          {t("common", K.new)}
        </button>
      </header>

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}
      {failure && <Alert>{failure}</Alert>}

      {isLoading ? (
        <TableSkeleton rows={4} columns={6} />
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3">
          <Alert>{message(error)}</Alert>
          <button type="button" className={quietButton} onClick={reload}>
            <RotateCw size={12} aria-hidden />
            {t("common", RESELLER_KEYS.retry)}
          </button>
        </div>
      ) : !rows || rows.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.empty)}</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-card-border bg-card-bg">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="text-[11px] text-text-secondary">
              <tr>
                <th className={cell}>{t("common", K.columns.name)}</th>
                <th className={cell}>{t("common", K.columns.monthly)}</th>
                <th className={cell}>{t("common", K.columns.yearly)}</th>
                <th className={cell}>{t("common", K.columns.rate)}</th>
                <th className={cell}>{t("common", K.columns.features)}</th>
                <th className={cell}>{t("common", K.columns.state)}</th>
                <th className={cell} />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-card-border align-top hover:bg-bg-inner">
                  <td className={`${cell} font-bold text-text-primary`}>{p.name}</td>
                  <td className={cell} dir="ltr">
                    {money(p.monthlyPrice, p.currencyCode)}
                  </td>
                  <td className={cell} dir="ltr">
                    {money(p.yearlyPrice, p.currencyCode)}
                  </td>
                  <td className={`${cell} text-text-secondary`}>{rateOf(p)}</td>
                  <td className={`${cell} text-xs text-text-secondary`}>
                    {p.includedFeatureKeys.map((k) => ((K.features as Record<string, string>)[k] ? t("common", (K.features as Record<string, string>)[k]) : k)).join("، ") || "—"}
                  </td>
                  <td className={`${cell} text-xs font-bold ${p.isActive ? "text-primary" : "text-text-secondary"}`}>
                    {t("common", p.isActive ? K.active : K.inactive)}
                  </td>
                  <td className={cell}>
                    <div className="flex flex-wrap justify-end gap-1">
                      <button type="button" className={quietButton} disabled={busy === p.id} onClick={() => setEditing(p)}>
                        {t("common", K.edit)}
                      </button>
                      <button type="button" className={quietButton} disabled={busy === p.id} onClick={() => toggleActive(p)}>
                        {t("common", p.isActive ? K.deactivate : K.activate)}
                      </button>
                      <button type="button" className={quietButton} disabled={busy === p.id} onClick={() => apply(p)}>
                        {t("common", K.apply)}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
