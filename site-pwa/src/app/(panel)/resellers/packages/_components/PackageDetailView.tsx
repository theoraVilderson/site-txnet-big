"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Boxes, Coins, Gauge, Loader2, Package, Sparkles, Tag, TrendingUp } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { PANEL_RESELLER_PACKAGES } from "@/lib/routes";
import { resellerLimitsApi, tenantApi, type PackageProduct, type TenantPackage } from "@/lib/tenant-api";
import { usePackageTexts } from "../../../_hooks/usePackageTexts";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { formatMoney } from "../../../_lib/money";
import { formatList } from "../../../_lib/digits";
import { useCatalogTexts, useMeterNames } from "../../../catalog/_lib/meter-names";
import { Alert as KitAlert, Button, Card, PageHeader, ReviewRows, type ReviewRow } from "../../../_components/kit";
import { Alert, Sheet, useMessage } from "../../_components/resellers-ui";
import { RESELLER_KEYS, canAdministerResellers } from "../../_lib/resellers";
import { LIMIT_KEYS } from "../../_lib/limits";
import { PACKAGE_KEYS as K, WHOLESALE_METERS, otherRates, packageFormOf } from "../../_lib/packages";
import { packageLimitsOf, sellsNothing, type PackageLimit, type PackageSection } from "../../_lib/package-page";
import { useHeld } from "../../limits/_components/LimitsView";
import { useOverageHeld } from "../../limits/_components/QuotaOverage";
import { ProductTermsList } from "../../limits/_components/PackageProducts";
import { usePackageActions } from "../_hooks/usePackageActions";
import { PackageSectionSheet } from "./PackageSectionSheet";
import { PackageLimitsSheet, PackageOverageSheet, useLimitName } from "./PackageLimitSheets";

type Open = PackageSection | "products" | "limits" | "overage";
type Loaded = { pkg: TenantPackage; limits: PackageLimit[]; listed: PackageProduct[] };

/** The products section's anchor: the "sells no product" flag links to it. */
const PRODUCTS_ANCHOR = "products";

/**
 * One package (PK-1-f, ADR-0154 (2)(8)): everything it sells and holds on one
 * page — name and prices, features, the platform products it lists with their
 * quotas, its limits and its answer past each quota beside the platform's, and
 * its wholesale rates — each section edited in its own sheet over the routes
 * that exist (`tenant/contract.admin.md` "Packages", `contract.limits.md`).
 * A package listing no product is flagged: it sells nothing (ADR-0107 point 3).
 * Who may see it is tenant-service's to decide, as on the list (rule 1).
 */
export function PackageDetailView({ id }: { id: string }) {
  const { t } = useLocale();
  const packageTexts = usePackageTexts();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const message = useMessage();
  const allowed = canAdministerResellers(me);
  const [data, setData] = useState<Loaded | null>(null);
  const productNames = useCatalogTexts();
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const [open, setOpen] = useState<Open | null>(null);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const actions = usePackageActions(reload);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    Promise.all([tenantApi.package(id), resellerLimitsApi.table(), resellerLimitsApi.packageProducts(id)]).then(
      ([pkg, table, listed]) => {
        if (!alive) return;
        setData({ pkg, limits: packageLimitsOf(table, id), listed });
        setError(null);
      },
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [allowed, id, asked]);

  const shell = (children: ReactNode) => <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">{children}</div>;
  if (sessionLoading) return null;
  if (!allowed) return shell(<Alert>{t("common", RESELLER_KEYS.refusals.not_platform_owner)}</Alert>);
  if (!data) {
    return shell(
      <>
        <Link href={PANEL_RESELLER_PACKAGES} className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
          <ArrowLeft size={14} aria-hidden />
          {t("common", K.page.back)}
        </Link>
        {error ? <Alert>{message(error)}</Alert> : <Loader2 size={18} className="mx-auto animate-spin text-text-secondary" aria-hidden />}
      </>,
    );
  }

  const { pkg, limits, listed } = data;
  const name = packageTexts.name(pkg);
  const saved = (p: TenantPackage) => {
    setOpen(null);
    actions.setFailure(null);
    actions.setNotice(t("common", K.saved, { name: packageTexts.name(p) }));
    reload();
  };
  const sheet = { packageId: pkg.id, packageName: name, limits, onClose: () => setOpen(null), onSaved: reload };

  return shell(
    <>
      <PageHeader
        icon={Package}
        tail={name}
        title={name}
        subtitle={t("common", pkg.isActive ? K.active : K.inactive)}
        actions={
          <>
            <Button variant="quiet" size="sm" disabled={actions.busy === pkg.id} onClick={() => void actions.toggleActive(pkg, name)}>
              {t("common", pkg.isActive ? K.deactivate : K.activate)}
            </Button>
            <Button variant="quiet" size="sm" disabled={actions.busy === pkg.id} onClick={() => void actions.apply(pkg)}>
              {t("common", K.apply)}
            </Button>
          </>
        }
      />
      {actions.notice && <p className="text-xs font-bold text-primary">{actions.notice}</p>}
      {actions.failure && <Alert>{actions.failure}</Alert>}
      {error !== null && <Alert>{message(error)}</Alert>}
      {sellsNothing(pkg) && (
        <KitAlert tone="warning" action={<a href={`#${PRODUCTS_ANCHOR}`} className="text-xs font-bold text-primary hover:underline">{t("common", K.page.toProducts)}</a>}>
          {t("common", K.page.sellsNothing)}
        </KitAlert>
      )}

      <Sections pkg={pkg} limits={limits} listed={listed} productNames={productNames} onEdit={setOpen} />

      {(open === "basics" || open === "features" || open === "rates") && <PackageSectionSheet pkg={pkg} section={open} onClose={() => setOpen(null)} onSaved={saved} />}
      {open === "products" && (
        <Sheet title={t("common", K.page.sheetTitle, { section: t("common", K.page.products), name })} onClose={() => setOpen(null)}>
          <p className="text-xs leading-5 text-text-secondary">{t("common", K.page.productsHint)}</p>
          <ProductTermsList packageId={pkg.id} onSaved={reload} />
        </Sheet>
      )}
      {open === "limits" && <PackageLimitsSheet {...sheet} />}
      {open === "overage" && <PackageOverageSheet {...sheet} />}
    </>,
  );
}

/** The page's six sections, each a card with its rows and a way into its sheet. */
function Sections({
  pkg,
  limits,
  listed,
  productNames,
  onEdit,
}: {
  pkg: TenantPackage;
  limits: PackageLimit[];
  listed: PackageProduct[];
  productNames: Record<string, string>;
  onEdit: (section: Open) => void;
}) {
  const { t, lang } = useLocale();
  const packageTexts = usePackageTexts();
  const meterName = useMeterNames();
  const held = useHeld();
  const overageHeld = useOverageHeld();
  const limitName = useLimitName();
  const P = LIMIT_KEYS.products;
  const money = (amount: string | null) => (amount === null ? "—" : formatMoney(amount, pkg.currencyCode, { lang, t }));
  const bound = (v: number | null) => (v === null ? t("common", LIMIT_KEYS.noLimit) : String(v));
  const productName = (p: PackageProduct) => productNames[p.nameKey] || p.key;
  const form = packageFormOf(pkg);
  const featureNames = pkg.includedFeatureKeys.map((k) => ((K.features as Record<string, string>)[k] ? t("common", (K.features as Record<string, string>)[k]) : k));
  const beside = (own: string, platform: string) => `${t("common", K.page.own, { value: own })} · ${t("common", K.page.platform, { value: platform })}`;

  const sections: { id: Open; icon: typeof Tag; title: string; rows: ReviewRow[]; anchor?: string }[] = [
    {
      id: "basics",
      icon: Tag,
      title: t("common", K.page.basics),
      rows: [
        [t("common", K.form.name), packageTexts.name(pkg)],
        [t("common", K.columns.monthly), <span key="m" dir="ltr">{money(pkg.monthlyPrice)}</span>],
        [t("common", K.columns.yearly), <span key="y" dir="ltr">{money(pkg.yearlyPrice)}</span>],
      ],
    },
    { id: "features", icon: Sparkles, title: t("common", K.page.features), rows: [[t("common", K.columns.features), formatList(featureNames, lang) || t("common", K.page.noFeatures)]] },
    {
      id: "products",
      icon: Boxes,
      title: t("common", K.page.products),
      anchor: PRODUCTS_ANCHOR,
      rows:
        listed.length === 0
          ? [[t("common", K.page.products), t("common", K.sellsNothingBadge)]]
          : listed.map((p): ReviewRow => [
              productName(p),
              t("common", P.listed, { day: bound(p.quota.day), week: bound(p.quota.week), month: bound(p.quota.month), past: overageHeld(p.quota.overage) }),
            ]),
    },
    { id: "limits", icon: Gauge, title: t("common", K.page.limits), rows: limits.map((l): ReviewRow => [limitName(l.key), beside(held(l.own), held(l.platform))]) },
    {
      id: "overage",
      icon: TrendingUp,
      title: t("common", K.page.overage),
      rows: limits.flatMap((l): ReviewRow[] => (l.overage ? [[limitName(l.key), beside(overageHeld(l.overage.own), overageHeld(l.overage.platform ?? undefined))]] : [])),
    },
    {
      id: "rates",
      icon: Coins,
      title: t("common", K.page.rates),
      rows: [
        ...WHOLESALE_METERS.map((m): ReviewRow => [meterName(m.meterKey), form.rates[m.meterKey] ? t("common", m.perUnit, { price: form.rates[m.meterKey], currency: pkg.currencyCode }) : "—"]),
        ...otherRates(pkg).map((r): ReviewRow => [meterName(r.meterKey), t("common", K.otherRate, { meter: meterName(r.meterKey), price: r.unitPrice, currency: r.currencyCode, size: r.unitSize })]),
      ],
    },
  ];

  return (
    <>
      {sections.map((s) => (
        <Card key={s.id} id={s.anchor} className="scroll-mt-20">
          <ReviewRows icon={s.icon} title={s.title} editLabel={t("common", K.edit)} onEdit={() => onEdit(s.id)} rows={s.rows} />
        </Card>
      ))}
    </>
  );
}
