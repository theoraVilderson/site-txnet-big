"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, HandCoins } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, type DepositGateway } from "@/lib/billing-api";
import { PANEL_TENANT_BILLING } from "@/lib/routes";
import { AmountInput } from "../../../deposit/_components/AmountInput";
import { GatewaySelector, gatewayKey } from "../../../deposit/_components/GatewaySelector";
import { topupBody } from "../_lib/topup";

const B = FrontendI18nKeys.common.tenantBilling.topupPage;

/**
 * A reseller tops up its billing wallet (F-019-e, D-41, ADR-0056): an amount,
 * one of the platform owner's gateways, then the bank.
 *
 * It borrows the deposit page's amount box and gateway picker and none of its
 * bill. There is no quote route for a billing top-up — no coupon, no test
 * mode, and `start` answers the breakdown — so the page holds two inputs and a
 * button, and the only figures it shows are the ones the user typed and the
 * gateway's range. The bank returns to the **platform's** panel host, not the
 * reseller's: the platform is the merchant (ADR-0056's accepted cost).
 *
 * Who may pay is the service's to decide; a refusal arrives on the gateway
 * read as a translated 403 and is shown where the list would be.
 */
export function TenantTopupView() {
  const { t } = useLocale();
  const messageFor = useApiErrorMessage();

  const [gateways, setGateways] = useState<DepositGateway[]>([]);
  const [gateway, setGateway] = useState<DepositGateway | null>(null);
  const [gatewaysError, setGatewaysError] = useState<string | null>(null);
  const [asked, setAsked] = useState(0);
  const [loaded, setLoaded] = useState(-1);
  const loadingGateways = loaded !== asked;

  const [amount, setAmount] = useState("");
  const [isStarting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await billingApi.tenantTopupGateways();
        if (!alive) return;
        setGateways(list);
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
    // `messageFor` is rebuilt each render by `useLocale`; see `DepositView`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);

  const body = topupBody(gateway, amount);
  const noGateway = !loadingGateways && !gatewaysError && gateways.length === 0;

  async function pay() {
    if (!body || isStarting) return;
    setStarting(true);
    setStartError(null);
    try {
      const started = await billingApi.tenantTopup(body);
      if (started.redirectUrl) {
        // Stay in the starting state: a button that came back to life here is a second start.
        window.location.assign(started.redirectUrl);
        return;
      }
      // A billing top-up is never free and never in chat (the route's CHECK), so
      // an answer with nowhere to go is a gateway fault, not a path of its own.
      setStartError(t("common", B.noRedirect));
    } catch (e) {
      setStartError(messageFor(e));
    }
    setStarting(false);
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-4 md:p-8">
      <Link
        href={PANEL_TENANT_BILLING}
        className="inline-flex items-center gap-1.5 text-xs font-bold text-text-secondary hover:text-text-primary"
      >
        <ArrowLeft size={14} className="rtl:rotate-180" aria-hidden />
        {t("common", B.back)}
      </Link>

      <header className="flex items-center gap-3">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-leaf-bg text-primary">
          <HandCoins size={24} aria-hidden />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-text-primary md:text-3xl">{t("common", B.title)}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t("common", B.subtitle)}</p>
        </div>
      </header>

      <AmountInput amount={amount} onAmountChange={setAmount} gateway={gateway} disabled={noGateway} />

      <GatewaySelector
        gateways={gateways}
        selected={gateway}
        onSelect={setGateway}
        isLoading={loadingGateways}
        error={gatewaysError}
        onRetry={() => setAsked((n) => n + 1)}
      />

      {noGateway && <p className="text-sm text-text-secondary">{t("common", B.noGateway)}</p>}

      <div className="space-y-3">
        {startError && (
          <p role="alert" className="text-sm font-bold text-error">
            {startError}
          </p>
        )}
        <button
          type="button"
          onClick={() => void pay()}
          disabled={!body || isStarting}
          aria-busy={isStarting}
          className="w-full rounded-2xl bg-primary px-5 py-4 text-sm font-bold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("common", isStarting ? B.paying : B.pay)}
        </button>
      </div>
    </div>
  );
}
