"use client";

import { Boxes, Coins, Gauge, Languages, Sparkles, TrendingUp } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { CatalogProduct } from "@/lib/catalog-api";
import type { ResellerLimitKey, ResellerLimitRow } from "@/lib/tenant-api";
import { Alert, Button, Checkbox, Input, ReviewRows, type ReviewRow } from "../../../_components/kit";
import { formatMoney } from "../../../_lib/money";
import { formatList } from "../../../_lib/digits";
import { LIMIT_KEYS } from "../../_lib/limits";
import { PACKAGE_KEYS, WHOLESALE_METERS } from "../../_lib/packages";
import { platformValueOf } from "../../_lib/package-page";
import { reviewWarnings, type LimitChoice, type PackageWizardForm, type PackageWizardStep, type ProductWindows } from "../../_lib/package-wizard";
import { useHeld } from "../../limits/_components/LimitsView";
import { useMeterNames } from "../../../catalog/_lib/meter-names";
import { useLimitName } from "./PackageLimitSheets";

const K = PACKAGE_KEYS.wizard;
const P = LIMIT_KEYS.products;
const WINDOWS = ["day", "week", "month"] as const;
const NO_WINDOW: ProductWindows = { day: "", week: "", month: "" };

type ProductName = (p: Pick<CatalogProduct, "nameKey" | "key">) => string;

/** Every offered platform product, ticked or not, and a ticked one's cap per window — blank is no cap (ADR-0154 (3)). */
export function ProductsStep({
  products,
  productName,
  value,
  onChange,
  errors,
}: {
  products: CatalogProduct[];
  productName: ProductName;
  value: Record<string, ProductWindows>;
  onChange: (next: Record<string, ProductWindows>) => void;
  errors: Record<string, string>;
}) {
  const { t } = useLocale();
  if (products.length === 0) return <Alert tone="warning">{t("common", K.noProducts)}</Alert>;
  const toggle = (id: string, on: boolean) => {
    const next = { ...value };
    if (on) next[id] = { ...NO_WINDOW };
    else delete next[id];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      {products.map((p) => {
        const name = productName(p);
        const windows = value[p.id];
        return (
          <div key={p.id} className="space-y-2 border-t border-card-border pt-3 first:border-t-0 first:pt-0">
            <Checkbox checked={windows !== undefined} onChange={(on) => toggle(p.id, on)} label={name} />
            {windows && (
              <div className="flex flex-wrap items-center gap-2 ps-7">
                {WINDOWS.map((w) => (
                  <label key={w} className="flex items-center gap-1 text-xs text-text-secondary">
                    {t("common", P.windows[w])}
                    <Input
                      className="w-24"
                      inputMode="numeric"
                      dir="ltr"
                      aria-label={`${name} — ${t("common", P.windows[w])}`}
                      placeholder={t("common", LIMIT_KEYS.noLimit)}
                      value={windows[w]}
                      onChange={(e) => onChange({ ...value, [p.id]: { ...windows, [w]: e.target.value } })}
                    />
                  </label>
                ))}
              </div>
            )}
            {errors[`products.${p.id}`] && <p className="ps-7 text-2xs text-error">{t("common", errors[`products.${p.id}`])}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** Every registry key at the platform's value; only a changed one is the package's own, and "no limit" is ticked, never left blank (ADR-0154 (3)). */
export function LimitsStep({
  rows,
  value,
  onChange,
  errors,
}: {
  rows: ResellerLimitRow[];
  value: Partial<Record<ResellerLimitKey, LimitChoice>>;
  onChange: (next: Partial<Record<ResellerLimitKey, LimitChoice>>) => void;
  errors: Record<string, string>;
}) {
  const { t } = useLocale();
  const held = useHeld();
  const limitName = useLimitName();
  const set = (key: ResellerLimitKey, choice: LimitChoice | null) => {
    const next = { ...value };
    if (choice && (choice.noLimit || choice.typed.trim() !== "")) next[key] = choice;
    else delete next[key];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => {
        const choice = value[row.key] ?? { typed: "", noLimit: false };
        const platform = held(platformValueOf(row));
        return (
          <div key={row.key} className="space-y-1.5 border-t border-card-border pt-3 first:border-t-0 first:pt-0">
            <p className="text-sm font-bold text-text-primary">{limitName(row.key)}</p>
            <p className="text-xs text-text-secondary">{t("common", K.platformValue, { value: platform })}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="w-28"
                inputMode="numeric"
                dir="ltr"
                aria-label={t("common", LIMIT_KEYS.valueFor, { name: limitName(row.key) })}
                placeholder={platform}
                value={choice.typed}
                disabled={choice.noLimit}
                onChange={(e) => set(row.key, { ...choice, typed: e.target.value })}
              />
              <Checkbox checked={choice.noLimit} onChange={(on) => set(row.key, { ...choice, noLimit: on })} label={t("common", LIMIT_KEYS.noLimit)} />
              {value[row.key] && (
                <Button variant="quiet" size="sm" onClick={() => set(row.key, null)}>
                  {t("common", K.usePlatform)}
                </Button>
              )}
            </div>
            {errors[`limits.${row.key}`] && <p className="text-2xs text-error">{t("common", K.errors.limit, { max: row.max })}</p>}
          </div>
        );
      })}
    </div>
  );
}

/** Each step's answers with a way back to it, then what the package will not sell, in words (ADR-0154 (3)). */
export function ReviewStep({
  form,
  currency,
  languageName,
  products,
  productName,
  limits,
  goTo,
}: {
  form: PackageWizardForm;
  currency: string;
  languageName: (code: string) => string;
  products: CatalogProduct[];
  productName: ProductName;
  limits: ResellerLimitRow[];
  goTo: (step: PackageWizardStep) => void;
}) {
  const { t, lang } = useLocale();
  const held = useHeld();
  const limitName = useLimitName();
  const meterName = useMeterNames();
  const none = t("common", K.none);
  const money = (v: string) => (v.trim() ? formatMoney(v.trim(), currency, { lang, t }) : none);
  const listed = products.filter((p) => form.products[p.id]).map(productName);
  const changed = limits.flatMap((r) => {
    const choice = form.limits[r.key];
    return choice ? [{ key: r.key, choice }] : [];
  });
  const warnings = reviewWarnings(form);

  const sections: { step: PackageWizardStep; icon: typeof Boxes; rows: ReviewRow[] }[] = [
    {
      step: "names",
      icon: Languages,
      rows: [
        [t("common", PACKAGE_KEYS.form.name), form.name.trim()],
        [t("common", K.sourceLang), languageName(form.sourceLang)],
        [t("common", K.description), form.description.trim() || none],
      ],
    },
    {
      step: "prices",
      icon: Coins,
      rows: [
        [t("common", PACKAGE_KEYS.columns.monthly), money(form.monthlyPrice)],
        [t("common", PACKAGE_KEYS.columns.yearly), money(form.yearlyPrice)],
      ],
    },
    {
      step: "features",
      icon: Sparkles,
      rows: [[t("common", PACKAGE_KEYS.columns.features), formatList(form.featureKeys.map((k) => t("common", (PACKAGE_KEYS.features as Record<string, string>)[k])), lang) || none]],
    },
    {
      step: "products",
      icon: Boxes,
      rows: [[t("common", K.steps.products), listed.length ? t("common", K.productsListed, { count: listed.length, names: formatList(listed, lang) }) : none]],
    },
    {
      step: "limits",
      icon: Gauge,
      rows: changed.length
        ? changed.map(({ key, choice }): ReviewRow => [limitName(key), choice.noLimit ? held(null) : choice.typed.trim()])
        : [[t("common", K.steps.limits), t("common", K.limitsPlatform)]],
    },
    {
      step: "rates",
      icon: TrendingUp,
      rows: WHOLESALE_METERS.map((m): ReviewRow => {
        const price = form.rates[m.meterKey].trim();
        return [t("common", m.label, { meter: meterName(m.meterKey), currency }), price ? t("common", m.perUnit, { price, currency }) : t("common", PACKAGE_KEYS.noRate)];
      }),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {sections.map((s) => (
        <section key={s.step} className="rounded-2xl border border-card-border p-3">
          <ReviewRows icon={s.icon} title={t("common", K.steps[s.step])} editLabel={t("common", K.edit)} onEdit={() => goTo(s.step)} rows={s.rows} />
        </section>
      ))}
      {warnings.length > 0 && (
        <Alert tone="warning" title={t("common", K.warnings)}>
          <ul className="list-disc space-y-1 ps-4">
            {warnings.map((w) => (
              <li key={w}>{t("common", w)}</li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}
