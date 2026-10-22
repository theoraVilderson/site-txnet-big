"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, type GrantRow, type RenewalPlan, type RenewalPlans } from "@/lib/billing-api";
import { PANEL_SHOP } from "@/lib/routes";
import { useCatalogTexts } from "../../catalog/_lib/meter-names";
import { formatMoney } from "../../_lib/money";
import { Alert, Button, Dialog, RadioCards, buttonClass, notify } from "../../_components/kit";
import { useCheckout } from "../../shop/_hooks/useCheckout";
import { CheckoutPay, ErrorBox } from "../../shop/_components/CheckoutPay";
import { formatBytes } from "../_lib/service-configs";
import { planAdds, renewalOffered } from "../_lib/renewal";

const R = FrontendI18nKeys.common.myServices.renew;
const SHOP = FrontendI18nKeys.common.shop;

/** The invoice maker for one plan of this Grant: a renewal, priced by billing (rule 5). */
const planInvoice = (grantId: string, variantId: string) => (codes: string[]) =>
  billingApi.createRenewalInvoice(grantId, { variantId }, codes);

/**
 * «تمدید» on a renewable Grant's row, and the sheet it opens (F-305-f,
 * panel-web `contract.renewal.md`). Nothing is read until it is pressed.
 */
export function Renewal({ row, name }: { row: GrantRow; name: string | null }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  if (!renewalOffered(row)) return null;
  return (
    <>
      <Button size="sm" variant="primary" icon={<RefreshCw size={14} aria-hidden />} onClick={() => setOpen(true)}>
        {t("common", R.action)}
      </Button>
      {open && <RenewalSheet row={row} name={name ?? row.variant?.sku ?? ""} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The plans billing would renew this Grant to, its own first (rule 2), and
 * the shop's checkout under the one picked (rule 5). A plan no longer sold is
 * said and the shop linked (rule 3). **Paid closes the sheet and patches
 * nothing**: the row re-reads on `entitlement.grant.renewed` (rule 6). A
 * refusal stays here, in billing's words (rule 7).
 */
function RenewalSheet({ row, name, onClose }: { row: GrantRow; name: string; onClose: () => void }) {
  const { t } = useLocale();
  const toMessage = useApiErrorMessage();
  const [plans, setPlans] = useState<RenewalPlans | null>(null);
  const [readError, setReadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const texts = useCatalogTexts();
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    billingApi.renewalPlans(row.id).then(
      (answer) => alive && setPlans(answer),
      (e: unknown) => alive && setReadError(e),
    );
    return () => {
      alive = false;
    };
  }, [row.id, asked]);

  // Billing answers the Grant's own plan first: that is the one picked until another is.
  const plan = plans?.plans.find((p) => p.variantId === picked) ?? plans?.plans[0] ?? null;
  const co = useCheckout({
    initial: null,
    listed: plan?.price ?? null,
    makeInvoice: plan ? planInvoice(row.id, plan.variantId) : null,
    onPaid: () => {
      notify.success(t("common", R.paid));
      onClose();
    },
  });

  const close = () => {
    co.leave();
    onClose();
  };
  const pick = (variantId: string) => {
    setPicked(variantId);
    co.restart(planInvoice(row.id, variantId));
  };

  return (
    <Dialog open onClose={close} size="lg" title={t("common", R.title, { name })}>
      <div className="space-y-5">
        {readError != null ? (
          <ErrorBox message={toMessage(readError)}>
            <button
              type="button"
              className="font-bold underline"
              onClick={() => {
                setReadError(null);
                setAsked((n) => n + 1);
              }}
            >
              {t("common", FrontendI18nKeys.common.myServices.retry)}
            </button>
          </ErrorBox>
        ) : plans === null ? (
          <p className="flex items-center gap-2 text-sm text-text-secondary">
            <Loader2 size={16} className="animate-spin" aria-hidden />
            {t("common", R.loading)}
          </p>
        ) : (
          <>
            {!plans.ownPlanRenewable && (
              <Alert
                tone="warning"
                action={
                  <Link href={PANEL_SHOP} className={buttonClass({ size: "sm" })}>
                    {t("common", R.toShop)}
                  </Link>
                }
              >
                {t("common", R.notSold)}
              </Alert>
            )}
            {plan && (
              <RadioCards
                columns={1}
                ariaLabel={t("common", R.plans)}
                value={plan.variantId}
                onChange={pick}
                options={plans.plans.map((p) => ({
                  value: p.variantId,
                  label: <PlanName plan={p} name={texts[p.nameKey] || p.sku} />,
                  description: <PlanFacts plan={p} row={row} />,
                }))}
              />
            )}
          </>
        )}

        {plan && (
          <CheckoutPay co={co} listed={plan.price} currency={plan.currencyCode} againLabel={t("common", R.again)} onAgain={() => co.restart()} />
        )}
      </div>
    </Dialog>
  );
}

function PlanName({ plan, name }: { plan: RenewalPlan; name: string }) {
  const { t } = useLocale();
  return (
    <span className="flex flex-wrap items-center gap-2">
      {name}
      {plan.current && <span className="rounded-full bg-leaf-bg px-2 py-0.5 text-2xs font-bold text-primary">{t("common", R.current)}</span>}
    </span>
  );
}

/** What it adds — traffic, days — and what it costs before any code, as billing answered (rule 2). */
function PlanFacts({ plan, row }: { plan: RenewalPlan; row: GrantRow }) {
  const { t, lang } = useLocale();
  const adds = planAdds(plan, row);
  const parts = [
    adds.traffic === "unlimited"
      ? t("common", R.unlimited)
      : adds.traffic && t("common", SHOP.traffic, { amount: formatBytes(adds.traffic.bytes, lang) ?? "" }),
    adds.days !== null && t("common", SHOP.duration, { days: adds.days }),
  ].filter(Boolean);
  return (
    <span className="flex flex-wrap items-center justify-between gap-2">
      <span>{parts.join(" · ")}</span>
      <span dir="ltr" className="font-bold text-text-primary">
        {formatMoney(plan.price, plan.currencyCode, { lang, t })}
      </span>
    </span>
  );
}
