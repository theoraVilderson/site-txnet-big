"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Clock, Gauge, Loader2, ShoppingCart, Smartphone, Wallet, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type InvoicePaid, type ShopInvoice, type ShopOffer } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { PANEL_DEPOSIT, PANEL_MY_SERVICES, panelDepositForInvoicePath } from "@/lib/routes";
import { flattenTexts } from "../../catalog/_lib/catalog-form";
import { formatBytes } from "../../services/_lib/service-configs";
import { useWalletBalance } from "../../_hooks/useWalletBalance";
import { formatInstant } from "../../_lib/datetime";
import { formatMoney } from "../../_lib/money";
import { categoriesOf, forgetReturnInvoice, groupOffers, hasOwnName, meteredStartShortOf, quotaLimit, shortfallOf, trafficRateOf, type OfferGroup } from "../_lib/shop";

const S = FrontendI18nKeys.common.shop;

/**
 * What the checkout is buying. `offer` is there when the shopper came from the
 * list; a return from a top-up (`?invoice=`) has only the invoice, so the
 * variant and its name are the invoice's.
 */
type Buying = { variantId: string; nameKey: string; sku: string; offer: ShopOffer | null };

type Phase =
  | { kind: "list" }
  | { kind: "checkout"; buying: Buying; invoice: ShopInvoice | null }
  | { kind: "paid"; buying: Buying; paid: InvoicePaid };

type Names = { of: (key: string | null, fallback: string) => string };

/**
 * The shop (F-111-e, rebuilt for a buyer by F-114-d; `panel-web/contract.shop.md`).
 *
 * **The list is cards to compare.** One card per product, its variants as
 * choices inside it, the picked one's facts and price on the card, and one
 * buy. Category tabs over the cards when there is more than one category.
 *
 * **The checkout is one page.** The order, the codes, the figure to pay and
 * the pay button sit together. No invoice is made for looking: one is made
 * when a code is applied (to show billing's discount) or on the pay press.
 * **An invoice replaced is cancelled first** — a code it holds counts as a use
 * for its 30 minutes, so a new invoice beside it would refuse that code.
 *
 * **Billing prices; the page never sends a figure.** What is paid is the
 * invoice's `total`, and a total other than the one on screen waits for a
 * second press. **A shortfall is a link, not a state** — back to this invoice.
 *
 * `invoiceId` is that return: the page opens on the invoice instead of the list.
 */
export function ShopView({ invoiceId }: { invoiceId: string | null }) {
  const { lang, t } = useLocale();
  const messageFor = useApiErrorMessage();
  const money = (value: string, currency: string) => formatMoney(value, currency, { lang, t });

  const [phase, setPhase] = useState<Phase>({ kind: "list" });
  const [offers, setOffers] = useState<ShopOffer[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  // The return is read once; after it, going back to the list is the list.
  const [returning, setReturning] = useState(invoiceId);

  useEffect(() => {
    let alive = true;
    catalogApi
      .texts(lang)
      .then(flattenTexts)
      .catch(() => ({}))
      .then((flat) => alive && setTexts(flat));
    return () => {
      alive = false;
    };
  }, [lang]);

  const onList = phase.kind === "list";
  useEffect(() => {
    if (!returning && (!onList || offers !== null)) return;
    let alive = true;
    (async () => {
      try {
        if (returning) {
          const invoice = await billingApi.invoice(returning);
          if (!alive) return;
          setReturning(null);
          setPhase({
            kind: "checkout",
            buying: { variantId: invoice.variantId, nameKey: invoice.nameKey, sku: invoice.sku, offer: null },
            invoice,
          });
        } else {
          const list = await billingApi.shopOffers();
          if (alive) setOffers(list);
        }
      } catch (e) {
        if (alive) setLoadError(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [returning, onList, offers, asked]);

  const names: Names = { of: (key, fallback) => (key && texts[key]) || fallback };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <header className="flex items-center gap-3">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-leaf-bg text-primary">
          <ShoppingCart size={24} aria-hidden />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-text-primary md:text-3xl">{t("common", S.title)}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", S.subtitle)}</p>
        </div>
      </header>

      {loadError ? (
        <ErrorBox message={messageFor(loadError)}>
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setAsked((n) => n + 1);
            }}
            className="font-bold underline"
          >
            {t("common", S.retry)}
          </button>
          {returning && (
            <button
              type="button"
              onClick={() => {
                setLoadError(null);
                setReturning(null);
              }}
              className="ms-3 font-bold underline"
            >
              {t("common", S.invoice.again)}
            </button>
          )}
        </ErrorBox>
      ) : phase.kind === "list" ? (
        returning ? (
          <Spinner />
        ) : (
          <OfferList
            offers={offers}
            names={names}
            money={money}
            onBuy={(offer) =>
              setPhase({
                kind: "checkout",
                buying: { variantId: offer.variantId, nameKey: offer.nameKey, sku: offer.sku, offer },
                invoice: null,
              })
            }
          />
        )
      ) : phase.kind === "checkout" ? (
        <Checkout
          key={phase.buying.variantId}
          buying={phase.buying}
          initial={phase.invoice}
          names={names}
          money={money}
          onBack={() => setPhase({ kind: "list" })}
          onPaid={(paid) => {
            forgetReturnInvoice();
            setPhase({ kind: "paid", buying: phase.buying, paid });
          }}
        />
      ) : (
        <Paid paid={phase.paid} name={names.of(phase.buying.nameKey, phase.buying.sku)} money={money} />
      )}
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-12 text-text-secondary">
      <Loader2 className="animate-spin" aria-hidden />
    </div>
  );
}

// -------------------------------------------------------------------- list

function OfferList({
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
          ? "border-primary bg-primary text-white"
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
  const [picked, setPicked] = useState(group.variants[0].variantId);
  const offer = group.variants.find((v) => v.variantId === picked) ?? group.variants[0];
  const labelOf = useVariantLabel(group, names);
  const description = group.descriptionKey ? names.of(group.descriptionKey, "") : "";
  const title = names.of(group.productNameKey, group.variants[0].sku);

  return (
    <article className="flex flex-col gap-4 rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm transition-shadow hover:shadow-md md:p-6">
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
                className={`rounded-2xl border px-3 py-2 text-sm font-bold transition-colors ${
                  on ? "border-primary bg-leaf-bg text-primary" : "border-card-border text-text-secondary hover:border-primary"
                }`}
              >
                {labelOf(v)}
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
          <OfferPrice offer={offer} money={money} />
        </div>
        <button
          type="button"
          onClick={() => onBuy(offer)}
          className="flex shrink-0 items-center gap-2 rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-white hover:brightness-110"
        >
          {t("common", S.buy)}
        </button>
      </div>
    </article>
  );
}

/** What the picked variant gives: its term, its traffic and its devices — only what the catalog set. */
function Facts({ offer }: { offer: ShopOffer }) {
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

// ---------------------------------------------------------------- checkout

/**
 * The order, the codes and the pay, on one page. One press pays once: the
 * claim is taken on the click, before any request, and covers the invoice it
 * may have to make first.
 */
function Checkout({
  buying,
  initial,
  names,
  money,
  onBack,
  onPaid,
}: {
  buying: Buying;
  initial: ShopInvoice | null;
  names: Names;
  money: (v: string, currency: string) => string;
  onBack: () => void;
  onPaid: (p: InvoicePaid) => void;
}) {
  const { t, lang } = useLocale();
  const messageFor = useApiErrorMessage();
  // What a purchase can spend: billing refuses held money (F-118-a), so the balance would promise more than it pays.
  const { available: balance, currencyCode: walletCurrency } = useWalletBalance();
  // A metered buy on a wallet that cannot start it is told before the pay (F-118-ah).
  const startShort = buying.offer ? meteredStartShortOf(buying.offer, balance, walletCurrency) : null;
  const busy = useRef(false);
  const [isBusy, setIsBusy] = useState(false);
  const [invoice, setInvoice] = useState<ShopInvoice | null>(initial);
  const [codes, setCodes] = useState<string[]>(initial ? initial.applied.map((a) => a.code) : []);
  const [rejected, setRejected] = useState<NonNullable<ShopInvoice["rejected"]>>([]);
  const [draft, setDraft] = useState("");
  const [missing, setMissing] = useState<string | null>(null);
  const [priceChanged, setPriceChanged] = useState(false);
  const [error, setError] = useState<{ message: string; ref?: string } | null>(null);

  const name = names.of(buying.nameKey, buying.sku);
  // The price before any code: the list's, or on a return the invoice's own.
  const listed = buying.offer?.price ?? initial?.amount ?? null;
  // Each figure in the currency its answer names (F-116-h3): the invoice's once there is one, the list's before.
  const currency = invoice?.currencyCode ?? buying.offer?.currencyCode ?? initial?.currencyCode ?? "";
  const open = invoice === null || invoice.status === "pending";

  /** Runs one step under the claim: a second press, or a code typed mid-pay, is ignored. */
  async function claimed(step: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setIsBusy(true);
    setError(null);
    setMissing(null);
    try {
      await step();
    } catch (e) {
      setError({ message: messageFor(e), ref: e instanceof ApiError ? e.ref : undefined });
    }
    busy.current = false;
    setIsBusy(false);
  }

  /** Gives the held codes back before anything replaces or leaves this invoice. Best effort: its clock frees them anyway. */
  async function release(current: ShopInvoice | null) {
    if (!current || current.status !== "pending") return;
    await billingApi.cancelInvoice(current.id).catch(() => {});
    forgetReturnInvoice();
  }

  /** A new invoice for these codes, replacing the one on screen. No code left means no invoice until the pay. */
  const requote = (next: string[]) =>
    claimed(async () => {
      await release(invoice);
      setInvoice(null);
      setPriceChanged(false);
      if (next.length === 0) {
        setCodes([]);
        setRejected([]);
        return;
      }
      setCodes(next);
      const made = await billingApi.createInvoice(buying.variantId, next);
      setInvoice(made);
      setCodes(made.applied.map((a) => a.code));
      setRejected(made.rejected ?? []);
    });

  const addCode = () => {
    const code = draft.trim().toUpperCase();
    setDraft("");
    if (code && !codes.includes(code)) void requote([...codes, code]);
  };

  const pay = () =>
    claimed(async () => {
      let current = invoice;
      if (!current) {
        current = await billingApi.createInvoice(buying.variantId, codes);
        setInvoice(current);
        // What was on screen was the price alone: a different total is shown, not paid.
        if (listed === null || current.total !== listed) {
          setPriceChanged(listed !== null && current.amount !== listed);
          return;
        }
      }
      try {
        onPaid(await billingApi.payInvoice(current.id));
      } catch (e) {
        const short = shortfallOf(e);
        if (short) {
          setMissing(short);
          return;
        }
        // Expired, already paid or cancelled since it was read: read it again,
        // so the status on screen is billing's and the button goes with it.
        if (e instanceof ApiError && e.status === 409) {
          const id = current.id;
          billingApi.invoice(id).then(setInvoice, () => {});
        }
        throw e;
      }
    });

  const back = () => {
    void release(invoice);
    onBack();
  };

  const until = invoice ? (formatInstant(invoice.expiresAt, lang) ?? "") : "";

  return (
    <div className="grid gap-4 md:grid-cols-5">
      <section className="space-y-4 rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm md:col-span-2 md:p-6">
        <button
          type="button"
          onClick={back}
          className="flex items-center gap-1 text-sm font-bold text-text-secondary hover:text-primary"
        >
          <ArrowRight size={16} className="ltr:rotate-180" aria-hidden />
          {t("common", S.checkout.back)}
        </button>
        <div>
          <p className="text-xs font-bold text-text-secondary">{t("common", S.checkout.summary)}</p>
          <h2 className="mt-1 text-lg font-bold text-text-primary">{name}</h2>
        </div>
        {buying.offer && <Facts offer={buying.offer} />}
      </section>

      <section className="space-y-5 rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm md:col-span-3 md:p-6">
        {open && (
          <div>
            <label htmlFor="shop-code" className="mb-1.5 block text-sm font-bold text-text-primary">
              {t("common", S.checkout.codeLabel)}
            </label>
            <div className="flex gap-2">
              <input
                id="shop-code"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCode();
                  }
                }}
                dir="ltr"
                className="min-w-0 flex-1 rounded-2xl border border-card-border bg-bg-inner px-4 py-2.5 text-sm"
              />
              <button
                type="button"
                onClick={addCode}
                disabled={isBusy}
                className="rounded-2xl border border-card-border px-4 text-sm font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
              >
                {t("common", S.checkout.addCode)}
              </button>
            </div>
            {codes.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2">
                {codes.map((code) => (
                  <li key={code} className="flex items-center gap-1 rounded-full bg-leaf-bg px-3 py-1 font-mono text-xs" dir="ltr">
                    {code}
                    <button
                      type="button"
                      disabled={isBusy}
                      aria-label={t("common", S.checkout.removeCode, { code })}
                      onClick={() => void requote(codes.filter((c) => c !== code))}
                    >
                      <X size={12} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {rejected.length > 0 && (
              <div className="mt-2 rounded-2xl border border-card-border bg-bg-inner p-3 text-xs">
                <p className="mb-1 font-bold text-text-primary">{t("common", S.invoice.rejected)}</p>
                <ul className="space-y-1 text-text-secondary">
                  {rejected.map((r) => (
                    <li key={r.code}>
                      <span dir="ltr" className="font-mono">
                        {r.code}
                      </span>{" "}
                      — {r.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <dl className="space-y-2 text-sm">
          <Line label={t("common", S.invoice.amount)} value={money(invoice?.amount ?? listed ?? "", currency)} />
          {invoice?.applied.map((a) => <Line key={a.code} label={a.code} value={`− ${money(a.discount, currency)}`} />)}
          <Line label={t("common", S.invoice.total)} value={money(invoice?.total ?? listed ?? "", currency)} strong />
        </dl>

        {balance !== null && walletCurrency !== null && open && (
          <p className="flex items-center gap-2 text-xs text-text-secondary">
            <Wallet size={14} aria-hidden />
            <span dir="auto">{t("common", S.checkout.balance, { balance: money(balance, walletCurrency) })}</span>
          </p>
        )}

        {startShort && open && !missing && (
          <div role="status" className="rounded-2xl border border-card-border bg-bg-inner p-4 text-sm">
            <p className="font-bold text-text-primary">{t("common", S.meteredStart.title)}</p>
            <p className="mt-1 text-text-secondary">{t("common", S.meteredStart.hint, { amount: money(startShort, walletCurrency ?? currency) })}</p>
            <Link
              href={invoice ? panelDepositForInvoicePath(invoice.id, startShort, invoice.currencyCode) : PANEL_DEPOSIT}
              className="mt-3 inline-block rounded-2xl bg-primary px-4 py-2 font-bold text-white hover:brightness-110"
            >
              {t("common", S.meteredStart.topUp)}
            </Link>
          </div>
        )}

        {invoice && !open && (
          <p className="rounded-2xl bg-bg-inner p-3 text-sm font-bold text-text-primary">{t("common", S.invoice.status[invoice.status])}</p>
        )}
        {invoice && open && <p className="text-xs text-text-secondary">{t("common", S.invoice.expiresAt, { time: until })}</p>}

        {priceChanged && (
          <p role="status" className="rounded-2xl bg-bg-inner p-3 text-sm font-bold text-text-primary">
            {t("common", S.checkout.priceChanged)}
          </p>
        )}

        {missing && invoice && (
          <div className="rounded-2xl border border-error-border bg-error-bg p-4 text-sm">
            <p className="font-bold text-error">{t("common", S.shortfall.title, { missing: money(missing, invoice.currencyCode) })}</p>
            <p className="mt-1 text-text-secondary">{t("common", S.shortfall.hint, { time: until })}</p>
            <Link
              href={panelDepositForInvoicePath(invoice.id, missing, invoice.currencyCode)}
              className="mt-3 inline-block rounded-2xl bg-primary px-4 py-2 font-bold text-white hover:brightness-110"
            >
              {t("common", S.shortfall.topUp, { amount: money(missing, invoice.currencyCode) })}
            </Link>
          </div>
        )}

        {error && <ErrorBox message={error.message} errorRef={error.ref} />}

        {open ? (
          <button
            type="button"
            onClick={() => void pay()}
            disabled={isBusy}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3.5 text-base font-bold text-white hover:brightness-110 disabled:opacity-50"
          >
            {isBusy && <Loader2 size={16} className="animate-spin" aria-hidden />}
            {t("common", S.invoice.pay)}
          </button>
        ) : (
          <button type="button" onClick={back} className="block w-full text-center text-sm font-bold text-primary underline">
            {t("common", S.invoice.again)}
          </button>
        )}
      </section>
    </div>
  );
}

// -------------------------------------------------------------------- paid

/**
 * Paid. No link or key is shown here (F-114-e-c, ADR-0085): billing keeps the
 * subscription link and My services shows it as often as asked, so this says
 * where it is and goes there.
 */
function Paid({ paid, name, money }: { paid: InvoicePaid; name: string; money: (v: string, currency: string) => string }) {
  const { t } = useLocale();

  return (
    <section className="mx-auto max-w-xl space-y-5 rounded-3xl border border-card-border bg-card-bg p-6 text-center shadow-lg md:p-8">
      <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-leaf-bg text-primary">
        <CheckCircle2 size={28} aria-hidden />
      </span>
      <div>
        <h2 className="text-xl font-bold text-text-primary">{t("common", S.paid.title)}</h2>
        <p className="mt-1 text-sm text-text-secondary">{name}</p>
        <p dir="ltr" className="mt-1 text-sm font-bold text-primary">
          {t("common", S.paid.balance, { balance: money(paid.balanceAfter, paid.currencyCode) })}
        </p>
      </div>

      <p className="text-xs text-text-secondary">{t("common", S.paid.preparing)}</p>
      <Link
        href={PANEL_MY_SERVICES}
        className="inline-block rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-white hover:brightness-110"
      >
        {t("common", S.paid.myServices)}
      </Link>
    </section>
  );
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "border-t border-card-border pt-2 text-base font-bold text-text-primary" : "text-text-secondary"}`}>
      <dt>{label}</dt>
      <dd dir="ltr">{value}</dd>
    </div>
  );
}

/** Billing's sentence, already translated, with its `ref` (`contract.errors.md`). */
function ErrorBox({ message, errorRef, children }: { message: string; errorRef?: string; children?: React.ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-2xl border border-error-border bg-error-bg px-4 py-3 text-sm font-medium text-error"
    >
      <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        {message}
        {errorRef && (
          <span className="mt-1 block font-mono text-[0.65rem] opacity-70" dir="ltr">
            {errorRef}
          </span>
        )}
        {children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  );
}
