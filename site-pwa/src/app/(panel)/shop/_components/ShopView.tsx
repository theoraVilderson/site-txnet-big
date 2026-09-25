"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, ShoppingCart, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type InvoicePaid, type ShopInvoice, type ShopOffer } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { PANEL_MY_SERVICES, PANEL_SHOP, panelDepositForInvoicePath } from "@/lib/routes";
import { flattenTexts } from "../../catalog/_lib/catalog-form";
import { formatInstant } from "../../_lib/datetime";
import { BASE_CURRENCY, formatMoney } from "../../_lib/money";
import { forgetReturnInvoice, groupOffers, shortfallOf } from "../_lib/shop";

const S = FrontendI18nKeys.common.shop;
const G = FrontendI18nKeys.common.wallet.gift;

type Phase =
  | { kind: "list" }
  | { kind: "checkout"; offer: ShopOffer }
  | { kind: "invoice"; invoice: ShopInvoice }
  | { kind: "paid"; invoice: ShopInvoice; paid: InvoicePaid };

/**
 * The shop (F-111-e, `panel-web/contract.shop.md`): what the caller may buy,
 * then buy -> invoice -> pay from the wallet.
 *
 * **Billing prices; the page never sends a figure.** The list shows the
 * catalog's price, the invoice is made from the variant and the typed codes,
 * and what is paid is the invoice's `total`.
 *
 * **A shortfall is a link, not a state.** Billing's `missing` goes to the
 * top-up page, which links back here with `?invoice=`, so the user returns to
 * the **same** invoice — its price and its held codes — and not a new one.
 *
 * `invoiceId` is that return: the page opens on the invoice instead of the list.
 */
export function ShopView({ invoiceId }: { invoiceId: string | null }) {
  const { lang, t } = useLocale();
  const messageFor = useApiErrorMessage();
  const money = (value: string) => formatMoney(value, BASE_CURRENCY, { lang, t });

  const [phase, setPhase] = useState<Phase>({ kind: "list" });
  const [offers, setOffers] = useState<ShopOffer[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);

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

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (invoiceId) {
          const invoice = await billingApi.invoice(invoiceId);
          if (alive) setPhase({ kind: "invoice", invoice });
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
  }, [invoiceId, asked]);

  const nameOf = (item: { nameKey: string; sku: string }) => texts[item.nameKey] || item.sku;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
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
          {invoiceId && (
            <Link href={PANEL_SHOP} className="ms-3 font-bold underline">
              {t("common", S.invoice.again)}
            </Link>
          )}
        </ErrorBox>
      ) : phase.kind === "list" ? (
        <OfferList offers={offers} nameOf={nameOf} money={money} onBuy={(offer) => setPhase({ kind: "checkout", offer })} />
      ) : phase.kind === "checkout" ? (
        <Checkout
          offer={phase.offer}
          name={nameOf(phase.offer)}
          money={money}
          onBack={() => setPhase({ kind: "list" })}
          onInvoice={(invoice) => setPhase({ kind: "invoice", invoice })}
        />
      ) : phase.kind === "invoice" ? (
        <InvoiceStep
          invoice={phase.invoice}
          name={nameOf(phase.invoice)}
          money={money}
          onPaid={(paid) => {
            forgetReturnInvoice();
            setPhase({ kind: "paid", invoice: phase.invoice, paid });
          }}
          onChanged={(invoice) => setPhase({ kind: "invoice", invoice })}
        />
      ) : (
        <Paid paid={phase.paid} name={nameOf(phase.invoice)} money={money} />
      )}
    </div>
  );
}

function OfferList({
  offers,
  nameOf,
  money,
  onBuy,
}: {
  offers: ShopOffer[] | null;
  nameOf: (o: ShopOffer) => string;
  money: (v: string) => string;
  onBuy: (o: ShopOffer) => void;
}) {
  const { t } = useLocale();
  if (offers === null) {
    return (
      <div className="flex justify-center py-12 text-text-secondary">
        <Loader2 className="animate-spin" aria-hidden />
      </div>
    );
  }
  if (offers.length === 0) {
    return <p className="rounded-3xl border border-card-border bg-card-bg p-8 text-center text-sm text-text-secondary">{t("common", S.empty)}</p>;
  }
  return (
    <div className="space-y-4">
      {groupOffers(offers).map((group) => (
        <section key={group.productId} className="rounded-3xl border border-card-border bg-card-bg p-4 shadow-sm md:p-6">
          <ul className="divide-y divide-card-border">
            {group.variants.map((offer) => (
              <li key={offer.variantId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-bold text-text-primary">{nameOf(offer)}</p>
                  <p className="text-xs text-text-secondary">
                    {offer.durationDays === null
                      ? t("common", S.permanent)
                      : t("common", S.duration, { days: offer.durationDays })}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span dir="ltr" className="font-bold text-primary">
                    {money(offer.price)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onBuy(offer)}
                    className="rounded-2xl bg-primary px-4 py-2 text-sm font-bold text-white hover:brightness-110"
                  >
                    {t("common", S.buy)}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The coupon box and "make the invoice". Codes are typed **before** the
 * invoice: billing holds the applied ones under it for its 30 minutes, so
 * changing them afterwards is a new invoice, not an edit.
 */
function Checkout({
  offer,
  name,
  money,
  onBack,
  onInvoice,
}: {
  offer: ShopOffer;
  name: string;
  money: (v: string) => string;
  onBack: () => void;
  onInvoice: (i: ShopInvoice) => void;
}) {
  const { t } = useLocale();
  const messageFor = useApiErrorMessage();
  const [draft, setDraft] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addCode = () => {
    const code = draft.trim().toUpperCase();
    if (code && !codes.includes(code)) setCodes([...codes, code]);
    setDraft("");
  };

  async function create() {
    if (isCreating) return;
    setIsCreating(true);
    setError(null);
    try {
      onInvoice(await billingApi.createInvoice(offer.variantId, codes));
    } catch (e) {
      setError(messageFor(e));
      setIsCreating(false);
    }
  }

  return (
    <section className="space-y-5 rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm md:p-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-text-primary">{name}</h2>
          <p dir="ltr" className="text-sm font-bold text-primary">
            {money(offer.price)}
          </p>
        </div>
        <button type="button" onClick={onBack} className="text-sm font-bold text-text-secondary underline">
          {t("common", S.checkout.back)}
        </button>
      </div>

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
            className="rounded-2xl border border-card-border px-4 text-sm font-bold text-text-primary hover:bg-leaf-bg"
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
                  aria-label={t("common", S.checkout.removeCode, { code })}
                  onClick={() => setCodes(codes.filter((c) => c !== code))}
                >
                  <X size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <ErrorBox message={error} />}

      <button
        type="button"
        onClick={() => void create()}
        disabled={isCreating}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3 text-sm font-bold text-white hover:brightness-110 disabled:opacity-50"
      >
        {isCreating && <Loader2 size={16} className="animate-spin" aria-hidden />}
        {t("common", S.checkout.create)}
      </button>
    </section>
  );
}

/**
 * The invoice and its pay button. One press pays once: the claim is taken on
 * the click, before the request, so a second press never reaches billing.
 */
function InvoiceStep({
  invoice,
  name,
  money,
  onPaid,
  onChanged,
}: {
  invoice: ShopInvoice;
  name: string;
  money: (v: string) => string;
  onPaid: (p: InvoicePaid) => void;
  onChanged: (i: ShopInvoice) => void;
}) {
  const { t, lang } = useLocale();
  const messageFor = useApiErrorMessage();
  const paying = useRef(false);
  const [isPaying, setIsPaying] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; ref?: string } | null>(null);

  async function pay() {
    if (paying.current) return;
    paying.current = true;
    setIsPaying(true);
    setError(null);
    setMissing(null);
    try {
      onPaid(await billingApi.payInvoice(invoice.id));
      return;
    } catch (e) {
      const short = shortfallOf(e);
      if (short) {
        setMissing(short);
      } else {
        setError({ message: messageFor(e), ref: e instanceof ApiError ? e.ref : undefined });
        // Expired, already paid or cancelled since it was read: read it again,
        // so the status on screen is billing's and the button goes with it.
        if (e instanceof ApiError && e.status === 409) {
          billingApi.invoice(invoice.id).then(onChanged, () => {});
        }
      }
    }
    paying.current = false;
    setIsPaying(false);
  }

  const open = invoice.status === "pending";
  const until = formatInstant(invoice.expiresAt, lang) ?? "";

  return (
    <section className="space-y-5 rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm md:p-8">
      <div>
        <h2 className="text-lg font-bold text-text-primary">{t("common", S.invoice.title)}</h2>
        <p className="text-sm text-text-secondary">{name}</p>
      </div>

      <dl className="space-y-2 text-sm">
        <Line label={t("common", S.invoice.amount)} value={money(invoice.amount)} />
        {invoice.applied.map((a) => (
          <Line key={a.code} label={a.code} value={`− ${money(a.discount)}`} />
        ))}
        <Line label={t("common", S.invoice.total)} value={money(invoice.total)} strong />
      </dl>

      {invoice.rejected && invoice.rejected.length > 0 && (
        <div className="rounded-2xl border border-card-border bg-bg-inner p-3 text-xs">
          <p className="mb-1 font-bold text-text-primary">{t("common", S.invoice.rejected)}</p>
          <ul className="space-y-1 text-text-secondary">
            {invoice.rejected.map((r) => (
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

      {open ? (
        <p className="text-xs text-text-secondary">{t("common", S.invoice.expiresAt, { time: until })}</p>
      ) : (
        <p className="rounded-2xl bg-bg-inner p-3 text-sm font-bold text-text-primary">
          {t("common", S.invoice.status[invoice.status])}
        </p>
      )}

      {missing && (
        <div className="rounded-2xl border border-error-border bg-error-bg p-4 text-sm">
          <p className="font-bold text-error">{t("common", S.shortfall.title, { missing: money(missing) })}</p>
          <p className="mt-1 text-text-secondary">{t("common", S.shortfall.hint, { time: until })}</p>
          <Link
            href={panelDepositForInvoicePath(invoice.id, missing)}
            className="mt-3 inline-block rounded-2xl bg-primary px-4 py-2 font-bold text-white hover:brightness-110"
          >
            {t("common", S.shortfall.topUp, { amount: money(missing) })}
          </Link>
        </div>
      )}

      {error && <ErrorBox message={error.message} errorRef={error.ref} />}

      {open ? (
        <button
          type="button"
          onClick={() => void pay()}
          disabled={isPaying}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary py-3 text-sm font-bold text-white hover:brightness-110 disabled:opacity-50"
        >
          {isPaying && <Loader2 size={16} className="animate-spin" aria-hidden />}
          {t("common", S.invoice.pay)}
        </button>
      ) : (
        <Link href={PANEL_SHOP} className="block text-center text-sm font-bold text-primary underline">
          {t("common", S.invoice.again)}
        </Link>
      )}
    </section>
  );
}

/**
 * Paid. The key is billing's answer to the pay and the one time it exists in
 * the clear (D-35), so it is shown with the gift modal's own sentences
 * (`contract.my-services.md` rule 5) and never kept; My services is the way back.
 */
function Paid({ paid, name, money }: { paid: InvoicePaid; name: string; money: (v: string) => string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(token);
    } catch {
      // No clipboard: the key stays selectable.
    }
  };

  return (
    <section className="space-y-5 rounded-3xl border border-card-border bg-card-bg p-6 text-center shadow-lg md:p-8">
      <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-leaf-bg text-primary">
        <CheckCircle2 size={28} aria-hidden />
      </span>
      <div>
        <h2 className="text-xl font-bold text-text-primary">{t("common", S.paid.title)}</h2>
        <p className="mt-1 text-sm text-text-secondary">{name}</p>
        <p dir="ltr" className="mt-1 text-sm font-bold text-primary">
          {t("common", S.paid.balance, { balance: money(paid.balanceAfter) })}
        </p>
      </div>

      {paid.grants.map((grant) => (
        <div key={grant.id} className="rounded-2xl border border-card-border bg-bg-inner p-3 text-start">
          <p className="mb-1.5 text-[10px] font-black uppercase tracking-widest text-text-secondary">{t("common", G.keyLabel)}</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-xs text-text-primary" dir="ltr">
              {grant.token}
            </code>
            <button
              type="button"
              onClick={() => void copy(grant.token)}
              className="shrink-0 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-white"
            >
              {t("common", copied === grant.token ? G.copied : G.copy)}
            </button>
          </div>
          <p className="mt-2 text-[11px] font-bold text-error">{t("common", G.keyOnce)}</p>
        </div>
      ))}

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
    <div className={`flex justify-between gap-3 ${strong ? "border-t border-card-border pt-2 font-bold text-text-primary" : "text-text-secondary"}`}>
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
