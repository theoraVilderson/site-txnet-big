"use client";

import { useState } from "react";
import { Check, Clock, Gauge, Loader2, Smartphone, Wallet } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { ShopOffer } from "@/lib/billing-api";
import { formatBytes } from "../../services/_lib/service-configs";
import { StatusPill } from "../../_components/kit/StatusPill";
import { categoriesOf, firstForSale, groupOffers, hasOwnName, quotaLimit, trafficRateOf, type OfferGroup } from "../_lib/shop";

const S = FrontendI18nKeys.common.shop;

/** A catalog text by key, else the fallback (the page reads the published `catalog` namespace). */
export type Names = { of: (key: string | null, fallback: string) => string };

export function Spinner() {
  return (
    <div className="flex justify-center py-12 text-text-secondary">
      <Loader2 className="animate-spin" aria-hidden />
    </div>
  );
}

/**
 * The shop's list (F-114-d): one card per product, its variants as choices
 * inside it. A sold-out variant stays on its card, named so and not buyable
 * (F-513-c, catalog `contract.sales-cap.md` rule 6); a card opens on the first
 * one still for sale.
 */
export function OfferList({
  offers,
  names,
  money,
  onBuy,
}: {
  offers: ShopOffer[] | null;
  names: Names;
  money: (v: string, currency: string) => string;
  onBuy: (o: ShopOffer) => void;
}) {
  const { t } = useLocale();
  const [category, setCategory] = useState<string | null>(null);
  if (offers === null) return <Spinner />;
  if (offers.length === 0) {
    return <p className="rounded-3xl border border-card-border bg-card-bg p-8 text-center text-sm text-text-secondary">{t("common", S.empty)}</p>;
  }

  const categories = categoriesOf(offers);
  const groups = groupOffers(offers).filter((g) => category === null || g.categoryKeys.includes(category));
  const tab = (key: string | null, label: string) => (
    <button
      key={key ?? ""}
      type="button"
      role="tab"
      aria-selected={category === key}
      onClick={() => setCategory(key)}
      className={`shrink-0 rounded-full border px-4 py-2 text-sm font-bold transition-colors ${
        category === key
          ? "border-primary bg-primary text-on-accent"
          : "border-card-border bg-card-bg text-text-secondary hover:border-primary hover:text-primary"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-5">
      {categories.length > 1 && (
        <div role="tablist" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0">
          {tab(null, t("common", S.all))}
          {categories.map((c) => tab(c.key, names.of(c.nameKey, c.key)))}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map((group) => (
          <ProductCard key={group.productId} group={group} names={names} money={money} onBuy={onBuy} />
        ))}
      </div>
    </div>
  );
}

/** The chip a variant is picked by: its own name if it has one, else its term — and its traffic when siblings differ on it. */
function useVariantLabel(group: OfferGroup, names: Names) {
  const { t, lang } = useLocale();
  const traffics = new Set(group.variants.map((v) => quotaLimit(v.quotas, "traffic_bytes")));
  return (offer: ShopOffer) => {
    if (hasOwnName(offer)) return names.of(offer.nameKey, offer.sku);
    const term = termOf(offer, t);
    const traffic = quotaLimit(offer.quotas, "traffic_bytes");
    return traffics.size > 1 && traffic !== null ? `${term} · ${formatBytes(String(traffic), lang)}` : term;
  };
}

function termOf(offer: { durationDays: number | null }, t: ReturnType<typeof useLocale>["t"]) {
  return offer.durationDays === null ? t("common", S.permanent) : t("common", S.duration, { days: offer.durationDays });
}

function ProductCard({
  group,
  names,
  money,
  onBuy,
}: {
  group: OfferGroup;
  names: Names;
  money: (v: string, currency: string) => string;
  onBuy: (o: ShopOffer) => void;
}) {
  const { t } = useLocale();
  const [picked, setPicked] = useState(firstForSale(group.variants).variantId);
  const offer = group.variants.find((v) => v.variantId === picked) ?? group.variants[0];
  const labelOf = useVariantLabel(group, names);
  const description = group.descriptionKey ? names.of(group.descriptionKey, "") : "";
  const title = names.of(group.productNameKey, group.variants[0].sku);

  return (
    <article className="flex flex-col gap-4 rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm transition-[box-shadow,transform,border-color] duration-200 hover:border-primary/40 hover:shadow-lg motion-safe:hover:-translate-y-1 md:p-6">
      <div>
        <h2 className="text-lg font-bold text-text-primary">{title}</h2>
        {description && <p className="mt-1 line-clamp-2 text-sm text-text-secondary">{description}</p>}
      </div>

      {group.variants.length > 1 && (
        <div role="radiogroup" aria-label={t("common", S.pick)} className="flex flex-wrap gap-2">
          {group.variants.map((v) => {
            const on = v.variantId === offer.variantId;
            return (
              <button
                key={v.variantId}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPicked(v.variantId)}
                className={`inline-flex items-center gap-1.5 rounded-2xl border px-3 py-2 text-sm font-bold transition-colors ${
                  on ? "border-primary bg-leaf-bg text-primary" : "border-card-border text-text-secondary hover:border-primary"
                }`}
              >
                {on && <Check size={14} aria-hidden />}
                {labelOf(v)}
                {v.soldOut && <SoldOut />}
              </button>
            );
          })}
        </div>
      )}

      <Facts offer={offer} />

      <div className="mt-auto flex items-end justify-between gap-3 border-t border-card-border pt-4">
        <div className="min-w-0">
          {group.variants.length === 1 && hasOwnName(offer) && (
            <p className="truncate text-xs font-bold text-text-secondary">{names.of(offer.nameKey, offer.sku)}</p>
          )}
          {offer.soldOut && group.variants.length === 1 && <SoldOut />}
          <OfferPrice offer={offer} money={money} />
        </div>
        <button
          type="button"
          onClick={() => onBuy(offer)}
          disabled={offer.soldOut}
          className="flex shrink-0 items-center gap-2 rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-on-accent hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("common", S.buy)}
        </button>
      </div>
    </article>
  );
}

/** What the picked variant gives: its term, its traffic and its devices — only what the catalog set. */
export function Facts({ offer }: { offer: ShopOffer }) {
  const { t, lang } = useLocale();
  const traffic = quotaLimit(offer.quotas, "traffic_bytes");
  const devices = quotaLimit(offer.quotas, "concurrent_devices");
  return (
    <ul className="space-y-2 text-sm text-text-secondary">
      <Fact icon={<Clock size={16} aria-hidden />}>{termOf(offer, t)}</Fact>
      {traffic !== null && (
        <Fact icon={<Gauge size={16} aria-hidden />}>{t("common", S.traffic, { amount: formatBytes(String(traffic), lang) ?? "" })}</Fact>
      )}
      {devices !== null && <Fact icon={<Smartphone size={16} aria-hidden />}>{t("common", S.devices, { count: devices })}</Fact>}
      {offer.billingMode === "metered" && (
        <Fact icon={<Wallet size={16} aria-hidden />}>{t("common", meteredLine(offer))}</Fact>
      )}
    </ul>
  );
}

/** Paid ahead or after, when the offer names its traffic rate; else the plain "pay as you use". */
function meteredLine(offer: ShopOffer): string {
  const rate = trafficRateOf(offer);
  if (!rate) return S.metered;
  return rate.mode === "postpaid" ? S.meteredPostpaid : S.meteredPrepaid;
}

/**
 * The card's figure (F-118-af): a metered offer with a traffic rate is priced
 * by its rate per GB — its sale price is usually 0.00, which is not what it
 * costs — and an upfront price beside it is still shown.
 */
function OfferPrice({ offer, money }: { offer: ShopOffer; money: (v: string, currency: string) => string }) {
  const { t } = useLocale();
  const rate = offer.billingMode === "metered" ? trafficRateOf(offer) : null;
  if (!rate) {
    return (
      <p dir="ltr" className="text-2xl font-black text-text-primary">
        {money(offer.price, offer.currencyCode)}
      </p>
    );
  }
  return (
    <div>
      <p className="flex items-baseline gap-1">
        <span dir="ltr" className="text-2xl font-black text-text-primary">
          {money(rate.unitPrice, rate.currencyCode)}
        </span>
        <span className="text-sm font-bold text-text-secondary">{t("common", S.perGb)}</span>
      </p>
      {Number(offer.price) > 0 && (
        <p className="text-xs text-text-secondary">{t("common", S.upfront, { amount: money(offer.price, offer.currencyCode) })}</p>
      )}
    </div>
  );
}

function Fact({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className="text-primary">{icon}</span>
      {children}
    </li>
  );
}

/** The sold-out mark: a status, in the kit's pill (K6). */
function SoldOut() {
  const { t } = useLocale();
  return (
    <StatusPill tone="error" dot={false} className="text-2xs">
      {t("common", S.soldOut)}
    </StatusPill>
  );
}
