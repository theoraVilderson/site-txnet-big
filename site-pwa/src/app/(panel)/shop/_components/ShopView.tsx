"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, CheckCircle2, ShoppingCart } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import { billingApi, type InvoicePaid, type ShopInvoice, type ShopOffer } from "@/lib/billing-api";
import { PANEL_MY_SERVICES } from "@/lib/routes";
import { useCatalogTexts } from "../../catalog/_lib/meter-names";
import { useWalletBalance } from "../../_hooks/useWalletBalance";
import { formatMoney } from "../../_lib/money";
import { forgetReturnInvoice, meteredStartShortOf, shopStep } from "../_lib/shop";
import { PageHeader } from "../../_components/kit/PageHeader";
import { useCelebration } from "../../_components/kit/celebrate";
import { useCheckout } from "../_hooks/useCheckout";
import { CheckoutPay, ErrorBox } from "./CheckoutPay";
import { ShopSteps } from "./ShopSteps";
import { Facts, OfferList, Spinner, type Names } from "./OfferList";
import { useCatalogSalesLive } from "../_hooks/useCatalogSalesLive";

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
 * `variantId` opens the checkout of one offered plan once the list is read
 * (F-038-h); one not on the list leaves the list, never a guessed checkout.
 */
export function ShopView({ invoiceId, variantId = null }: { invoiceId: string | null; variantId?: string | null }) {
  const { lang, t, isRtl } = useLocale();
  const messageFor = useApiErrorMessage();
  const money = (value: string, currency: string) => formatMoney(value, currency, { lang, t });
  const reduced = useMotionLevel() === "reduced";

  const [phase, setPhase] = useState<Phase>({ kind: "list" });
  const [offers, setOffers] = useState<ShopOffer[] | null>(null);
  const texts = useCatalogTexts();
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  // The return is read once; after it, going back to the list is the list.
  const [returning, setReturning] = useState(invoiceId);
  // So is the plan asked for: "back" from its checkout is the list.
  const [wanted, setWanted] = useState(variantId);

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
          if (!alive) return;
          setOffers(list);
          const offer = wanted ? list.find((o) => o.variantId === wanted) : undefined;
          setWanted(null);
          if (offer) {
            setPhase({ kind: "checkout", buying: { variantId: offer.variantId, nameKey: offer.nameKey, sku: offer.sku, offer }, invoice: null });
          }
        }
      } catch (e) {
        if (alive) setLoadError(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [returning, onList, offers, asked, wanted]);

  // F-513-c: a variant sold out or released elsewhere re-reads the list; a
  // failed read is the same retry box as the first one.
  useCatalogSalesLive(() => void billingApi.shopOffers().then(setOffers, setLoadError));

  const names: Names = { of: (key, fallback) => (key && texts[key]) || fallback };

  // U1: the steps slide the way they are walked — forward from the end side,
  // back from the start side; opacity alone under reduced motion (M3).
  const step = shopStep(phase.kind);
  const [steps, setSteps] = useState({ now: step, direction: 1 });
  if (steps.now !== step) setSteps({ now: step, direction: step > steps.now ? 1 : -1 });
  const slide = reduced ? { opacity: 0 } : { x: steps.direction * (isRtl ? -24 : 24), opacity: 0 };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-8">
      <PageHeader
        icon={ShoppingCart}
        title={t("common", S.title)}
        subtitle={t("common", S.subtitle)}
      />
      <ShopSteps current={step} />

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
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={phase.kind}
            initial={slide}
            animate={{ x: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? DURATION.fast : DURATION.base, ease: EASE.standard }}
          >
            {phase.kind === "list" ? (
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
                onBack={() => setPhase({ kind: "list" })}
                onPaid={(paid) => {
                  forgetReturnInvoice();
                  setPhase({ kind: "paid", buying: phase.buying, paid });
                }}
              />
            ) : (
              <Paid paid={phase.paid} name={names.of(phase.buying.nameKey, phase.buying.sku)} money={money} />
            )}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- checkout

/**
 * The order beside the pay (`CheckoutPay`, over `useCheckout`). A returned
 * renewal invoice (F-305-f, `contract.renewal.md` rule 5) pays as it is: its
 * codes were chosen on My services' sheet, which alone knows what it renews.
 */
function Checkout({
  buying,
  initial,
  names,
  onBack,
  onPaid,
}: {
  buying: Buying;
  initial: ShopInvoice | null;
  names: Names;
  onBack: () => void;
  onPaid: (p: InvoicePaid) => void;
}) {
  const { t } = useLocale();
  // A metered buy on a wallet that cannot start it is told before the pay (F-118-ah).
  const { available: balance, currencyCode: walletCurrency } = useWalletBalance();
  const startShort = buying.offer ? meteredStartShortOf(buying.offer, balance, walletCurrency) : null;
  // The price before any code: the list's, or on a return the invoice's own.
  const listed = buying.offer?.price ?? initial?.amount ?? null;
  const co = useCheckout({
    initial,
    listed,
    makeInvoice: initial?.renewal ? null : (codes) => billingApi.createInvoice(buying.variantId, codes),
    onPaid,
  });

  const back = () => {
    co.leave();
    onBack();
  };

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
          <h2 className="mt-1 text-lg font-bold text-text-primary">{names.of(buying.nameKey, buying.sku)}</h2>
        </div>
        {buying.offer && <Facts offer={buying.offer} />}
      </section>

      <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm md:col-span-3 md:p-6">
        <CheckoutPay
          co={co}
          listed={listed}
          // Each figure in the currency its answer names (F-116-h3): the invoice's once there is one, the list's before.
          currency={buying.offer?.currencyCode ?? initial?.currencyCode ?? ""}
          startShort={startShort}
          againLabel={t("common", S.invoice.again)}
          onAgain={back}
        />
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
  // M5: the purchase is delivered — once, on the step's arrival.
  useCelebration(true);

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
        className="inline-block rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-on-accent hover:brightness-110"
      >
        {t("common", S.paid.myServices)}
      </Link>
    </section>
  );
}
