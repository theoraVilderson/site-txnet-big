"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpCircle, Boxes, PiggyBank } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { catalogApi } from "@/lib/catalog-api";
import { PANEL_TENANT_BILLING_TOPUP } from "@/lib/routes";
import {
  resellerLimitsApi,
  resellerPurchaseApi,
  tenantApi,
  type OverageCapView,
  type OverageView,
  type PackageOffer,
  type ProductQuotaInEffect,
  type ResellerBillingModel,
  type SubscriptionChangePreview,
} from "@/lib/tenant-api";
import { flattenTexts } from "../../../catalog/_lib/catalog-form";
import { Alert } from "../../../catalog/_components/catalog-ui";
import { formatInstant } from "../../../_lib/datetime";
import { formatMoney } from "../../../_lib/money";
import { MY_LIMIT_KEYS as L, MY_QUOTA_KEYS as Q, capAmountOf, changeVerdict, includedReading } from "../../_lib/limits";

const box = "w-32 rounded-xl border border-card-border bg-bg-inner px-3 py-2 text-sm text-text-primary outline-none focus:border-primary";
const primary = "rounded-xl bg-primary px-3 py-2 text-xs font-bold text-white disabled:opacity-50";
const quiet = "rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-secondary disabled:opacity-50";

/** Money in its currency, or the amount as it came when there is none to name. */
export function useMoney() {
  const { t, lang } = useLocale();
  return (amount: string, currency: string | null) => (currency ? formatMoney(amount, currency, { lang, t }) : amount);
}

/** What happens past a quota, in words: refused, or the price of each extra unit. */
export function usePastText() {
  const { t } = useLocale();
  const money = useMoney();
  return (o: OverageView) => (o.mode === "stop" ? t("common", Q.pastStop) : t("common", Q.pastPrice, { price: money(o.unitPrice ?? "", o.currencyCode) }));
}

/** A thin bar; gold at Full, as the limits card's. */
export function Bar({ share, full }: { share: number | null; full: boolean }) {
  if (share === null) return null;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-card-border" aria-hidden>
      <div className={`h-full rounded-full ${full ? "bg-gold" : "bg-primary"}`} style={{ width: `${Math.round(share * 100)}%` }} />
    </div>
  );
}

/**
 * The platform products this reseller sells and what it sold of each, window
 * by window (F-019-v10, `GET /tenants/:id/limits/products`) — the engine's own
 * count. A product taken off the package is shown until the paid period ends.
 */
export function ProductQuotasCard({ tenantId }: { tenantId: string }) {
  const { t, lang } = useLocale();
  const message = useApiErrorMessage();
  const money = useMoney();
  const past = usePastText();
  const [rows, setRows] = useState<ProductQuotaInEffect[] | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    resellerLimitsApi.productsOf(tenantId).then(
      (v) => alive && setRows(v),
      (e) => alive && setError(e),
    );
    catalogApi
      .texts(lang)
      .then(flattenTexts)
      .catch(() => ({}))
      .then((flat) => alive && setTexts(flat));
    return () => {
      alive = false;
    };
  }, [tenantId, lang]);

  return (
    <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-5">
      <div className="flex items-center gap-2">
        <Boxes className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-bold text-text-primary">{t("common", Q.products.title)}</h2>
      </div>
      <p className="text-xs text-text-secondary">{t("common", Q.products.subtitle)}</p>
      {error !== null && <Alert>{message(error)}</Alert>}
      {rows && rows.length === 0 && <p className="text-xs text-text-secondary">{t("common", Q.products.none)}</p>}
      {rows && rows.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map((p) => {
            const name = texts[p.nameKey] || p.key;
            const sold = p.windows.reduce((a, w) => Math.max(a, w.overageQty), 0);
            const cost = p.windows.find((w) => w.period.kind === "month")?.overageAmount ?? "0.00";
            return (
              <li key={p.productId} role="group" aria-label={name} className="space-y-2 rounded-xl bg-bg-inner p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-bold text-text-primary">{name}</span>
                  {!p.listed && <span className="text-[11px] text-text-secondary">{t("common", Q.products.heldUntilEnd)}</span>}
                </div>
                {p.windows.map((w) => {
                  const r = includedReading(w.included, w.includedUsed);
                  const figure =
                    w.included === null ? t("common", L.usedNoLimit, { used: w.includedUsed }) : t("common", L.usedOf, { used: w.includedUsed, limit: w.included });
                  return (
                    <div key={w.period.kind} className="space-y-1">
                      <div className="text-xs text-text-primary">{`${t("common", Q.windows[w.period.kind])}: ${figure}`}</div>
                      <Bar {...r} />
                    </div>
                  );
                })}
                {sold > 0 && <div className="text-[11px] text-text-secondary">{t("common", Q.extraMonth, { cost: money(cost, p.overage.currencyCode) })}</div>}
                <div className="text-[11px] text-text-secondary">{past(p.overage)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The reseller's own cap on what extras may cost per subscription month
 * (F-019-v10, ADR-0107 point 6): this month's spend against it, set, or
 * removed. `0` allows no extras at all; reaching it behaves as `stop`.
 */
export function OverageCapCard({ tenantId }: { tenantId: string }) {
  const { t, lang } = useLocale();
  const message = useApiErrorMessage();
  const money = useMoney();
  const [view, setView] = useState<OverageCapView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const amount = capAmountOf(typed);

  useEffect(() => {
    let alive = true;
    resellerLimitsApi.overageCap(tenantId).then(
      (v) => alive && setView(v),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [tenantId]);

  const save = async (value: string | null) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      setView(await resellerLimitsApi.setOverageCap(tenantId, value));
      setTyped("");
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-5">
      <div className="flex items-center gap-2">
        <PiggyBank className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-bold text-text-primary">{t("common", Q.cap.title)}</h2>
      </div>
      <p className="text-xs text-text-secondary">{t("common", Q.cap.subtitle)}</p>
      {error !== null && <Alert>{message(error)}</Alert>}
      {view && (
        <>
          <p className="text-sm font-bold text-text-primary">
            {view.cap === null
              ? t("common", Q.cap.spentNoCap, { spent: money(view.spent, view.currencyCode) })
              : t("common", Q.cap.spentOf, { spent: money(view.spent, view.currencyCode), cap: money(view.cap, view.currencyCode) })}
          </p>
          <p className="text-[11px] text-text-secondary">{t("common", Q.cap.month, { end: formatInstant(view.month.end, lang, { withTime: false }) ?? "" })}</p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              inputMode="decimal"
              dir="ltr"
              aria-label={t("common", Q.cap.amount)}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className={box}
            />
            <button type="button" className={primary} disabled={busy || amount === undefined} onClick={() => amount !== undefined && save(amount)}>
              {t("common", Q.cap.save)}
            </button>
            {view.cap !== null && (
              <button type="button" className={quiet} disabled={busy} onClick={() => save(null)}>
                {t("common", Q.cap.remove)}
              </button>
            )}
          </div>
          <p className="text-[11px] text-text-secondary">{t("common", Q.cap.hint)}</p>
        </>
      )}
      {failure && <Alert>{failure}</Alert>}
    </section>
  );
}

/**
 * Change package (F-019-v10, ADR-0107 point 9): the preview's figures first —
 * an upgrade applies at once for the prorated price shown, from the billing
 * wallet; a cheaper package waits for the renewal. Too little in the wallet
 * offers a top-up instead of a button. Nothing is priced here.
 */
export function PackageChangeCard({ tenantId }: { tenantId: string }) {
  const { t, lang } = useLocale();
  const message = useApiErrorMessage();
  const money = useMoney();
  const [offers, setOffers] = useState<PackageOffer[] | null>(null);
  const [packageId, setPackageId] = useState("");
  const [billingModel, setBillingModel] = useState<ResellerBillingModel>("subscription_monthly");
  const [preview, setPreview] = useState<SubscriptionChangePreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let alive = true;
    resellerPurchaseApi.packages().then(
      (v) => alive && setOffers(v),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setPreview(null);
    if (!packageId) return;
    let alive = true;
    tenantApi.subscriptionChange(tenantId, packageId, billingModel).then(
      (p) => {
        if (!alive) return;
        setPreview(p);
        setError(null);
      },
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [tenantId, packageId, billingModel, asked]);

  const verdict = preview ? changeVerdict(preview) : null;
  const charge = preview ? money(preview.charge, preview.currencyCode) : "";
  const balance = preview ? money(preview.balance, preview.currencyCode) : "";
  const renewal = preview ? (formatInstant(preview.currentPeriodEnd, lang, { withTime: false }) ?? "") : "";

  const apply = async () => {
    if (busy || !preview || (verdict !== "now" && verdict !== "renewal")) return;
    const question = verdict === "now" ? t("common", Q.change.confirmNow, { charge }) : t("common", Q.change.confirmRenewal, { date: renewal });
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await tenantApi.changeSubscription(tenantId, { packageId, billingModel });
      setDone(t("common", verdict === "now" ? Q.change.doneNow : Q.change.doneRenewal));
      setAsked((n) => n + 1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-5">
      <div className="flex items-center gap-2">
        <ArrowUpCircle className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-bold text-text-primary">{t("common", Q.change.title)}</h2>
      </div>
      <p className="text-xs text-text-secondary">{t("common", Q.change.subtitle)}</p>
      {offers && (
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={t("common", Q.change.package)} value={packageId} onChange={(e) => setPackageId(e.target.value)} className={`${box} w-48`}>
            <option value="">{t("common", Q.change.pick)}</option>
            {offers.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select aria-label={t("common", Q.change.period)} value={billingModel} onChange={(e) => setBillingModel(e.target.value as ResellerBillingModel)} className={`${box} w-40`}>
            <option value="subscription_monthly">{t("common", Q.change.monthly)}</option>
            <option value="subscription_yearly">{t("common", Q.change.yearly)}</option>
          </select>
        </div>
      )}
      {preview && verdict && (
        <div className="space-y-2 rounded-xl bg-bg-inner p-3 text-xs">
          <p className="font-bold text-text-primary">
            {verdict === "none"
              ? t("common", Q.change.none)
              : verdict === "renewal"
                ? t("common", Q.change.renewal, { date: renewal })
                : t("common", verdict === "short" ? Q.change.short : Q.change.now, { charge, balance })}
          </p>
          {verdict === "now" && (
            <button type="button" className={primary} disabled={busy} onClick={apply}>
              {t("common", Q.change.upgrade)}
            </button>
          )}
          {verdict === "renewal" && (
            <button type="button" className={quiet} disabled={busy} onClick={apply}>
              {t("common", Q.change.atRenewal)}
            </button>
          )}
          {verdict === "short" && (
            <Link href={PANEL_TENANT_BILLING_TOPUP} className="font-bold text-primary hover:underline">
              {t("common", Q.change.topUp)}
            </Link>
          )}
        </div>
      )}
      {done && <p className="text-xs font-bold text-primary">{done}</p>}
      {error !== null && <Alert>{message(error)}</Alert>}
    </section>
  );
}
