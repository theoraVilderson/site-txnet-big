"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, HandCoins, Loader2, Store } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi } from "@/lib/billing-api";
import { PANEL_DEPOSIT, myResellerDomainsPath } from "@/lib/routes";
import {
  resellerPurchaseApi,
  type OwnedReseller,
  type PackageOffer,
  type Purchased,
  type ResellerBillingModel,
} from "@/lib/tenant-api";
import { useResellerPanelOpener } from "../../../_components/ResellerPanelButton";
import { Select } from "../../../_components/kit/Select";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { formatInstant } from "../../../_lib/datetime";
import { formatMoney } from "../../../_lib/money";
import { Alert, Field, StatusBadge, input, primaryButton } from "../../_components/resellers-ui";
import { BILLING_MODELS, RESELLER_KEYS } from "../../_lib/resellers";
import {
  PURCHASE_KEYS as K,
  canBuyReseller,
  emptyPurchaseForm,
  isInsufficientBalance,
  offerChoices,
  offerPrice,
  ownedHosts,
  purchaseBody,
  purchaseRefusalKey,
  suggestibleName,
  validatePurchase,
  type PurchaseForm,
} from "../../_lib/purchase";
import type { Errors } from "../../_lib/resellers";

/** The suggestion is asked as the name is typed; the same wait the owner picker uses. */
const SUGGEST_AFTER_MS = 300;

/**
 * A platform user buys a reseller of their own (F-019-i, ADR-0061). The
 * packages on sale, a name that suggests an address the buyer may edit, the
 * period, then `POST /api/tenants/purchase` — paid from their own wallet, and
 * the reseller opens `active` at once.
 *
 * The rules this page holds (`panel-web/contract.resellers.md`):
 *  - **every choice is one the service takes.** Periods are `BILLING_MODELS`;
 *    a package is offered for a period only when priced for it. The service
 *    reads both again under the package's lock, so this only saves a round
 *    trip — it is never the check.
 *  - **the slug is a suggestion until the buyer edits it.** Once they type in
 *    it, the name no longer overwrites it; left empty, the body omits it and
 *    the purchase takes the one the name suggests.
 *  - **`insufficient_balance` is the one refusal with somewhere to go.** It is
 *    shown with the top-up beside it, because the sentence alone leaves the
 *    buyer on a page they cannot complete.
 *  - **no figure is computed here.** The price is the offer's, the balance
 *    billing's, and what the purchase charged is the answer's `charged`.
 *  - **a buyer who already holds one sees it, not a form** (F-019-l).
 *    `GET /purchase/mine` is asked first, and the packages only when it answers
 *    `null` — the form would end in `already_reseller`.
 */
export function BuyResellerView() {
  const { lang, t } = useLocale();
  const { me } = usePanelSession();
  const message = usePurchaseMessage();

  /** `undefined` until asked; `null` for a buyer who holds none. */
  const [held, setHeld] = useState<OwnedReseller | null | undefined>(undefined);
  const [offers, setOffers] = useState<PackageOffer[] | null>(null);
  const [balance, setBalance] = useState<{ amount: string; currency: string } | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);

  const [form, setForm] = useState<PurchaseForm>(emptyPurchaseForm);
  const [errors, setErrors] = useState<Errors<PurchaseForm>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [bought, setBought] = useState<Purchased | null>(null);
  /** Once the buyer types in the address, the name stops writing over it. */
  const slugEdited = useRef(false);
  const set = (patch: Partial<PurchaseForm>) => setForm((f) => ({ ...f, ...patch }));

  const mayBuy = canBuyReseller(me);

  // The reseller the buyer already holds, first: it decides which page this is.
  // Only then the packages on sale and the buyer's wallet — two services, one
  // wait, because the price is worth nothing without the balance beside it.
  useEffect(() => {
    if (!mayBuy) return;
    let alive = true;
    (async () => {
      try {
        const { reseller } = await resellerPurchaseApi.mine();
        if (!alive) return;
        setHeld(reseller);
        if (reseller) return setLoadError(null);
        const [onSale, wallet] = await Promise.all([resellerPurchaseApi.packages(), billingApi.walletBalance()]);
        if (!alive) return;
        setOffers(onSale);
        setBalance({ amount: wallet.balance, currency: wallet.currencyCode });
        setLoadError(null);
      } catch (e) {
        if (!alive) return;
        setLoadError(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [mayBuy, asked]);

  // The address the name suggests, until the buyer edits it themselves.
  useEffect(() => {
    const name = suggestibleName(form.name);
    if (!mayBuy || slugEdited.current || !name) return;
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const { slug } = await resellerPurchaseApi.suggestSlug(name);
        if (alive && !slugEdited.current) set({ slug });
      } catch {
        // A suggestion is a convenience: the buyer can type one, and the
        // purchase takes the name's own when the field is left empty.
      }
    }, SUGGEST_AFTER_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [form.name, mayBuy]);

  const choices = offerChoices(offers ?? [], form.billingModel);
  const picked = choices.find((o) => o.id === form.packageId) ?? null;
  const price = picked ? offerPrice(picked, form.billingModel) : null;
  const money = (amount: string, currency: string) => formatMoney(amount, currency, { lang, t });

  // A period the picked package is not sold for drops the pick, rather than
  // sending one the service would refuse `package_not_sold_for_period`.
  function setPeriod(billingModel: ResellerBillingModel) {
    const keeps = offerChoices(offers ?? [], billingModel).some((o) => o.id === form.packageId);
    set({ billingModel, ...(keeps ? {} : { packageId: "" }) });
  }

  async function submit() {
    const found = validatePurchase(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await resellerPurchaseApi.purchase(purchaseBody(form));
      setBought(answer);
      setBalance({ amount: answer.walletBalance, currency: answer.currencyCode });
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  if (!mayBuy) {
    return (
      <Shell title={t("common", K.title)} subtitle={t("common", K.subtitle)}>
        <Alert>{t("common", K.refusals.not_platform_user)}</Alert>
      </Shell>
    );
  }

  if (held) {
    return (
      <Shell title={t("common", K.title)} subtitle={t("common", K.subtitle)}>
        <HeldReseller reseller={held} />
      </Shell>
    );
  }

  if (bought) {
    // The reseller's only platform host is its CNAME target, which opens
    // nothing (ADR-0063): the next step is a domain of its own, added on its
    // workspace's domains page (F-066-w2) — not a link to the target.
    const target = bought.domains.find((d) => d.domainType === "subdomain")?.domainValue;
    return (
      <Shell title={t("common", K.title)} subtitle={t("common", K.subtitle)}>
        <div className="rounded-2xl border border-card-border bg-card-bg p-6 text-center">
          <CheckCircle2 size={32} className="mx-auto text-primary" aria-hidden />
          <h2 className="mt-3 text-lg font-bold text-text-primary">{t("common", K.done.title)}</h2>
          <p className="mt-2 text-sm text-text-secondary">
            {t("common", K.done.body, {
              slug: bought.slug,
              charged: money(bought.charged, bought.currencyCode),
              date: formatInstant(bought.currentPeriodEnd, lang, { withTime: false }) ?? bought.currentPeriodEnd,
            })}
          </p>
          <p className="mt-1 text-sm text-text-secondary">
            {t("common", K.done.balance, { balance: money(bought.walletBalance, bought.currencyCode) })}
          </p>
          {target && (
            <p className="mt-4 text-sm text-text-primary">
              {t("common", K.done.next, { target })}
            </p>
          )}
          <Link href={myResellerDomainsPath(bought.id)} className={`${primaryButton} mt-4`}>
            {t("common", K.done.addDomain)}
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title={t("common", K.title)}
      subtitle={t("common", K.subtitle)}
      aside={
        balance !== null && (
          <div className="rounded-2xl border border-card-border bg-card-bg px-5 py-3">
            <p className="text-[11px] text-text-secondary">{t("common", K.balance)}</p>
            <p dir="ltr" className="text-lg font-bold text-gold">
              {money(balance.amount, balance.currency)}
            </p>
          </div>
        )
      }
    >
      {offers === null ? (
        loadError ? (
          <div className="space-y-3">
            <Alert>{message(loadError)}</Alert>
            <button type="button" className={primaryButton} onClick={() => setAsked((n) => n + 1)}>
              {t("common", K.reload)}
            </button>
          </div>
        ) : (
          <TableSkeleton rows={4} columns={2} />
        )
      ) : (
        <div className="space-y-5 rounded-2xl border border-card-border bg-card-bg p-5">
          <Field label={t("common", K.period)}>
            <Select
              value={form.billingModel}
              onChange={(v) => setPeriod(v as ResellerBillingModel)}
              options={BILLING_MODELS.map((m) => ({ value: m, label: t("common", RESELLER_KEYS.period[m]) }))}
            />
          </Field>

          <Field label={t("common", K.package)} error={errors.packageId}>
            {choices.length === 0 ? (
              <p className="text-sm text-text-secondary">{t("common", K.noPackages)}</p>
            ) : (
              <Select
                value={form.packageId}
                onChange={(v) => set({ packageId: v })}
                options={choices.map((o) => ({ value: o.id, label: `${o.name} — ${money(offerPrice(o, form.billingModel) as string, o.currencyCode)}` }))}
                invalid={!!errors.packageId}
              />
            )}
          </Field>

          {picked && picked.includedFeatureKeys.length > 0 && (
            <p className="text-xs text-text-secondary">
              {t("common", K.included)}: {picked.includedFeatureKeys.join("، ")}
            </p>
          )}

          <Field label={t("common", K.name)} hint={t("common", K.nameHint)} error={errors.name}>
            <input className={input} value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>

          <Field label={t("common", K.slug)} hint={t("common", K.slugHint)} error={errors.slug}>
            <input
              className={input}
              dir="ltr"
              value={form.slug}
              onChange={(e) => {
                slugEdited.current = true;
                set({ slug: e.target.value });
              }}
            />
          </Field>

          {failure !== null && (
            <div className="space-y-3">
              <Alert>{message(failure)}</Alert>
              {isInsufficientBalance(failure) && (
                <Link
                  href={PANEL_DEPOSIT}
                  className="inline-flex items-center gap-2 rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-white hover:brightness-110"
                >
                  <HandCoins size={16} aria-hidden />
                  {t("common", K.topup)}
                </Link>
              )}
            </div>
          )}

          <button type="button" className={primaryButton} disabled={busy || !picked} onClick={submit}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {t("common", K.submit, { price: price && picked ? money(price, picked.currencyCode) : "—" })}
          </button>
        </div>
      )}
    </Shell>
  );
}

/**
 * The reseller this buyer already holds (F-019-l): its package and period, its
 * address, and the way into its panel — the sidebar entry's own handoff. The
 * CNAME target is said as where to point a domain, never linked (ADR-0063).
 * Renewal and a package upgrade belong here as they are built.
 */
function HeldReseller({ reseller }: { reseller: OwnedReseller }) {
  const { lang, t } = useLocale();
  const { pending, open } = useResellerPanelOpener();
  const hosts = ownedHosts(reseller);
  const H = K.owned;
  const periodEnd = reseller.currentPeriodEnd
    ? (formatInstant(reseller.currentPeriodEnd, lang, { withTime: false }) ?? reseller.currentPeriodEnd)
    : null;
  const period = reseller.billingModel in RESELLER_KEYS.period
    ? t("common", RESELLER_KEYS.period[reseller.billingModel as ResellerBillingModel])
    : reseller.billingModel;

  return (
    <div className="space-y-5 rounded-2xl border border-card-border bg-card-bg p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-text-primary">{t("common", H.title)}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t("common", H.body, { slug: reseller.slug })}</p>
        </div>
        <StatusBadge status={reseller.status} />
      </div>

      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-text-secondary">{t("common", H.package)}</dt>
          <dd className="mt-1 font-medium text-text-primary">
            {reseller.package ? `${reseller.package.name} — ${period}` : t("common", H.noPackage)}
          </dd>
        </div>
        {periodEnd && (
          <div>
            <dt className="text-xs text-text-secondary">{t("common", H.periodEnd)}</dt>
            <dd className="mt-1 font-medium text-text-primary">{periodEnd}</dd>
          </div>
        )}
        <div className="sm:col-span-2">
          <dt className="text-xs text-text-secondary">{t("common", H.address)}</dt>
          <dd className="mt-1 font-medium text-text-primary">
            {hosts.panel ? (
              <span dir="ltr">{hosts.panel}</span>
            ) : (
              t("common", H.noAddress, { target: hosts.target ?? "—" })
            )}
          </dd>
        </div>
      </dl>

      <button type="button" className={primaryButton} disabled={pending !== null} onClick={() => open(reseller.id)}>
        {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Store size={16} aria-hidden />}
        {t("common", pending ? H.opening : H.open)}
      </button>
    </div>
  );
}

/**
 * The refusal's own sentence, else the generic answer for that error.
 *
 * Not `resellers-ui`'s `useMessage`: that one reads the **administration**'s
 * refusal set, where `insufficient_balance` is a reseller's balance with the
 * platform and `already_reseller` has no sentence at all. A buyer gets the
 * purchase's own words (`PURCHASE_REFUSAL_KEYS`).
 */
function usePurchaseMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = purchaseRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

/** The page frame, so the refusal, the success and the form all sit the same. */
function Shell({
  title,
  subtitle,
  aside,
  children,
}: {
  title: string;
  subtitle: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-8">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary md:text-3xl">{title}</h1>
          <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>
        </div>
        {aside}
      </header>
      {children}
    </div>
  );
}
