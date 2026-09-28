"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ShoppingCart, Sparkles } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi, type DepositGateway, type DepositStarted } from "@/lib/billing-api";
import { openMiniAppInvoice } from "@/lib/mini-app";
import { panelShopInvoicePath } from "@/lib/routes";
import { prefillAmount, rememberReturnInvoice, type ForInvoice } from "../../../shop/_lib/shop";
import { useWalletBalance } from "../../../_hooks/useWalletBalance";
import { PaymentPendingView } from "../../../payment/_components/PaymentPendingView";
import { formatMoney } from "../../../_lib/money";
import { useDepositQuote } from "../_hooks/useDepositQuote";
import { useStartOnce } from "../_hooks/useStartOnce";
import { useVerifyingGuard } from "../_hooks/useVerifyingGuard";
import { AmountInput } from "./AmountInput";
import { CouponInput } from "./CouponInput";
import { GatewaySelector, gatewayKey } from "./GatewaySelector";
import { PaymentSummary } from "./PaymentSummary";
import { VerifyingBanner, VerifyingConfirm } from "./VerifyingNotice";
import { WalletPreview } from "./WalletPreview";

const D = FrontendI18nKeys.common.deposit;

/**
 * The top-up page (F-093-e).
 *
 * **The page holds inputs; `billing` holds the bill.** Its whole state is what
 * the user chose — a gateway, an amount, a list of codes — and every figure on
 * screen comes back from `POST /deposit/quote` for exactly those
 * (`useDepositQuote`). Legacy's `Deposit.tsx` held the fee, the tax, the
 * adjustment gap, the discount total and a projected balance as component
 * state and recomputed each of them in the render, beside a server that
 * computed the same five (F-0612).
 *
 * **Paying sends the quote's own body, not its numbers.** `start` re-prices
 * from the same inputs with the same code, so a client cannot pay a figure it
 * was shown a minute ago at a rate that has since moved.
 *
 * Two things this page owns that no quote can answer: the browser's trip to the
 * gateway, and the free path — a fully discounted top-up is credited by `start`
 * itself and there is nowhere to send anyone, so the result is shown here
 * rather than on F-093-f's return pages.
 *
 * Inside a Mini App there is a third (F-104-o): an in-chat gateway answers an
 * invoice link, the messenger's own sheet takes the payment, and the page then
 * waits on the row exactly as `/payment/pending` does (F-093-l) — the sheet's
 * "paid" is the host's word, and only the bot's relay credits the wallet. A
 * sheet that closed without paying is the one thing only this page sees, so it
 * is the one thing it reports: `POST /deposit/:id/abandon` gives the payment's
 * coupon holds back at once (F-093-q), and the retry the payer makes a second
 * later is not refused a one-use code the messenger never charged for.
 */
export function DepositView({ forInvoice = null }: { forInvoice?: ForInvoice | null } = {}) {
  const { lang, t } = useLocale();
  const messageFor = useApiErrorMessage();
  const { balance, currencyCode: walletCurrency, refresh } = useWalletBalance();

  const [gateways, setGateways] = useState<DepositGateway[]>([]);
  const [gateway, setGateway] = useState<DepositGateway | null>(null);
  const [gatewaysError, setGatewaysError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  // Loading is derived rather than stored, the way `useFinancialPage` derives
  // it: the picker shows its skeleton in the render that asked, not one render
  // later once an effect has set a flag.
  const [loaded, setLoaded] = useState(-1);
  const loadingGateways = loaded !== asked;

  const [typedAmount, setAmount] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  // Opened for an invoice's shortfall (F-111-e): the amount is the shortfall
  // raised to the chosen gateway's minimum — derived, so it follows the picker
  // — until the user types one of their own.
  const [typed, setTyped] = useState(false);
  const amount =
    forInvoice && !typed ? prefillAmount(forInvoice.missing, gateway?.minAmount ?? null) : typedAmount;
  const onAmountChange = useCallback((value: string) => {
    setTyped(true);
    setAmount(value);
  }, []);
  // The bank returns to `/payment/success`, which has no other way to know the
  // user was on their way to an invoice.
  useEffect(() => {
    if (forInvoice) rememberReturnInvoice(forInvoice.invoiceId);
  }, [forInvoice]);

  // One press of Pay starts one payment (F-093-r): the claim is taken on the
  // click, before the verifying check's network read, not inside `pay()`.
  const { isStarting, claim, release } = useStartOnce();
  // A refusal of `start` belongs to the inputs it was refused for (F-093-t),
  // exactly as a quote belongs to the body it was asked for: it is held with
  // the key of those inputs, so a changed gateway, amount or code drops it in
  // the render that changed them — not once a new answer happens to arrive,
  // and not when the next `pay()` clears it by hand.
  const [startError, setStartError] = useState<{ key: string; message: string } | null>(null);
  /** Set only on the free path, where there is no gateway to be sent to. */
  const [credited, setCredited] = useState<DepositStarted | null>(null);
  /** A payment the messenger's sheet took, or may still be taking (F-104-o). */
  const [awaiting, setAwaiting] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await billingApi.depositGateways();
        if (!alive) return;
        setGateways(list);
        // The first one, as the route ordered it — platform gateways first,
        // each table oldest first. A page that opened with nothing selected
        // would show an empty bill until the user noticed the picker.
        setGateway((current) =>
          current && list.some((g) => gatewayKey(g) === gatewayKey(current)) ? current : (list[0] ?? null),
        );
        setGatewaysError(null);
      } catch (e) {
        if (alive) setGatewaysError(messageFor(e));
      } finally {
        if (alive) setLoaded(asked);
      }
    })();
    return () => {
      alive = false;
    };
    // `messageFor` is rebuilt each render by `useLocale`; the list does not
    // depend on the language, and re-reading it on one would be a second call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  const quote = useDepositQuote({ gateway, amount, codes });
  const inputsKey = JSON.stringify([gateway && gatewayKey(gateway), amount, codes]);
  const startMessage = startError?.key === inputsKey ? startError.message : null;
  // A payment the gateway met with silence: shown, and asked about before a
  // second one — warn and confirm, never block (F-093-m, ADR-0044 decision 7).
  const verifyingGuard = useVerifyingGuard();
  const onPay = () => {
    if (!claim()) return;
    void verifyingGuard.guard(() => void pay());
  };
  // The payer kept the first payment: back to the form, and the button with it.
  const onVerifyingCancel = () => {
    verifyingGuard.cancel();
    release();
  };

  const addCode = useCallback((code: string) => setCodes((all) => [...all, code]), []);
  const removeCode = useCallback(
    (code: string) => setCodes((all) => all.filter((c) => c !== code)),
    [],
  );

  async function pay() {
    if (!gateway || !quote.quote) {
      release();
      return;
    }
    setStartError(null);
    const key = inputsKey;
    const fail = (message: string) => setStartError({ key, message });
    try {
      // The quote's body, never its numbers (F-0612).
      const started = await billingApi.depositStart({
        gatewayId: gateway.id,
        source: gateway.source,
        amount,
        couponCodes: codes,
      });
      if (started.redirectUrl) {
        // Stay in the starting state: the page is on its way out, and a button
        // that came back to life here is a second `start` and a second hold.
        window.location.assign(started.redirectUrl);
        return;
      }
      if (started.invoiceLink) {
        const closed = await openMiniAppInvoice(started.invoiceLink);
        if (closed === "paid" || closed === "pending") {
          // Whatever the sheet said, the row is what credits: watch it.
          setAwaiting(started.paymentId);
        } else {
          // Nothing was paid (F-093-q). `start` already holds this payment's
          // coupons, and until the row closes a one-use code answers
          // `per_user_limit_reached` — so the retry the payer is about to make
          // would be refused for a payment the messenger never charged. Let
          // billing give the holds back now; it refuses the payment itself if
          // pre-checkout has already approved it. Nothing waits on the answer
          // and a failure here only costs the wait it saved.
          void billingApi.depositAbandon(started.paymentId).catch(() => {});
          if (closed === "failed") {
            fail(t("common", D.summary.inChatFailed));
          } else if (closed === "unavailable") {
            fail(t("common", D.summary.inChatUnavailable));
          }
          // Cancelled is the payer's own choice and needs no sentence.
        }
        release();
        return;
      }
      // The free path: `start` credited the wallet inside its own transaction
      // and minted nothing. The balance shown is billing's answer to that call.
      setCredited(started);
      refresh();
      release();
    } catch (e) {
      // A coupon that can no longer be held is a 409 and nothing was written
      // (`billing/contract.deposit.md`), so the same inputs priced again come
      // back with the code in `rejected` and the breakdown without it — which
      // is the only way the bill on screen stops being one the payer cannot
      // have. Nothing else re-prices: a 400 on the range, a 503 at the gateway
      // and a 429 from the limiter would all get the same answer back, and the
      // quote route has a budget of its own to spend (F-093-s).
      if (e instanceof ApiError && e.status === 409) quote.retry();
      // The sentence is billing's, already translated.
      fail(messageFor(e));
      release();
    }
  }

  function reset() {
    setCredited(null);
    setAmount("");
    setCodes([]);
    setStartError(null);
  }

  if (awaiting) return <PaymentPendingView paymentId={awaiting} />;

  if (credited) {
    const money = (value: string) => formatMoney(value, credited.currencyCode, { lang, t });
    return (
      <div className="mx-auto w-full max-w-2xl p-4 md:p-8">
        <div className="rounded-3xl border border-card-border bg-card-bg p-8 text-center shadow-lg">
          <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-leaf-bg text-primary">
            <CheckCircle2 size={28} aria-hidden />
          </span>
          <h1 className="mt-4 text-xl font-bold text-text-primary">{t("common", D.summary.freeTitle)}</h1>
          <p className="mt-2 text-sm text-text-secondary">
            {t("common", D.summary.freeDone, { amount: money(credited.credited) })}
          </p>
          {credited.balance !== null && (
            <p dir="ltr" className="mt-1 text-sm font-bold text-primary">
              {t("common", D.summary.newBalance, { balance: money(credited.balance) })}
            </p>
          )}
          {forInvoice ? (
            <Link
              href={panelShopInvoicePath(forInvoice.invoiceId)}
              className="mt-6 inline-block rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-white hover:brightness-110"
            >
              {t("common", D.forInvoice.back)}
            </Link>
          ) : (
            <button
              type="button"
              onClick={reset}
              className="mt-6 rounded-2xl bg-primary px-5 py-3 text-sm font-bold text-white hover:brightness-110"
            >
              {t("common", D.summary.again)}
            </button>
          )}
        </div>
      </div>
    );
  }

  const noGateway = !loadingGateways && gateways.length === 0;
  const summary = (
    <PaymentSummary
      quote={quote.quote}
      isQuoting={quote.isQuoting}
      error={quote.error ? messageFor(quote.error) : startMessage}
      isStarting={isStarting}
      onPay={onPay}
    />
  );

  return (
    // The mobile footer is `fixed`, so the column ends above where it sits.
    <div className="mx-auto w-full max-w-6xl p-4 pb-56 md:p-8 md:pb-8">
      <header className="mb-8 flex items-center gap-3">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-leaf-bg text-primary">
          <Sparkles size={24} aria-hidden />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-text-primary md:text-3xl">{t("common", D.title)}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", D.subtitle)}</p>
        </div>
      </header>

      {forInvoice && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-card-border bg-leaf-bg px-4 py-3 text-sm">
          <span className="flex items-center gap-2 text-text-primary">
            <ShoppingCart size={18} className="text-primary" aria-hidden />
            {t("common", D.forInvoice.notice, { amount: formatMoney(forInvoice.missing, forInvoice.currency, { lang, t }) })}
          </span>
          <Link href={panelShopInvoicePath(forInvoice.invoiceId)} className="font-bold text-primary underline">
            {t("common", D.forInvoice.back)}
          </Link>
        </div>
      )}

      {verifyingGuard.verifying && <VerifyingBanner payment={verifyingGuard.verifying} />}
      {verifyingGuard.warning && (
        <VerifyingConfirm
          payment={verifyingGuard.warning}
          onConfirm={verifyingGuard.confirm}
          onCancel={onVerifyingCancel}
        />
      )}

      <div className="flex flex-col gap-8 md:flex-row md:items-start">
        <div className="w-full space-y-6 md:w-7/12">
          <div className="md:hidden">
            <WalletPreview
              balance={balance}
              balanceCurrency={walletCurrency}
              credited={quote.quote?.credited ?? null}
              creditedCurrency={quote.quote?.currencyCode ?? null}
            />
          </div>

          <AmountInput
            amount={amount}
            onAmountChange={onAmountChange}
            gateway={gateway}
            currency={gateway?.currencyCode ?? walletCurrency}
            disabled={noGateway}
          />

          <CouponInput
            codes={codes}
            onAdd={addCode}
            onRemove={removeCode}
            quote={quote.quote}
            disabled={noGateway}
          />

          <GatewaySelector
            gateways={gateways}
            selected={gateway}
            onSelect={setGateway}
            isLoading={loadingGateways}
            error={gatewaysError}
            onRetry={() => setAsked((n) => n + 1)}
          />
        </div>

        {/* Sticky beside the form: the bill stays in view while the amount and
            the codes above it change. `top-24` clears the shell's top bar. */}
        <div className="hidden w-full space-y-6 md:sticky md:top-24 md:block md:w-5/12">
          <WalletPreview
              balance={balance}
              balanceCurrency={walletCurrency}
              credited={quote.quote?.credited ?? null}
              creditedCurrency={quote.quote?.currencyCode ?? null}
            />
          {summary}
        </div>
      </div>

      {/* The same component below `md`, collapsed: one bill, one set of
          figures, and no second copy of the pay button's disabled rules. */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-card-border bg-card-bg/95 px-4 pb-6 pt-3 backdrop-blur-xl md:hidden">
        <PaymentSummary
          quote={quote.quote}
          isQuoting={quote.isQuoting}
          error={quote.error ? messageFor(quote.error) : startMessage}
          isStarting={isStarting}
          onPay={onPay}
          compact
        />
      </div>
    </div>
  );
}
