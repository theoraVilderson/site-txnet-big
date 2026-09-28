"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Coins,
  CreditCard,
  Hash,
  Landmark,
  Percent,
  Receipt,
  TimerOff,
  Wallet,
} from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { WalletPaymentRow } from "@/lib/billing-api";
import { formatMoney } from "../../_lib/money";
import { formatInstant } from "../../_lib/datetime";
import { GATEWAY_TONES, paymentTone } from "../_lib/tones";
import { Badge } from "./Badge";
import { DetailItem } from "./DetailItem";
import { ExpandableRow } from "./ExpandableRow";

const F = FrontendI18nKeys.common.financial;

/** A decimal string that is not zero — a fee, a tax or a discount worth a line of its own. */
const isSet = (amount: string) => Number(amount) !== 0;

/**
 * One top-up attempt (F-093-d).
 *
 * This row carries a `status` and **no balance**, because an attempt is not a
 * movement: only a `success` payment has a ledger row, and F-092-j is what
 * writes it. Legacy put both in one table and let a `failed` attempt count
 * toward the running balance beside it.
 *
 * The amount shown is `amountCredited` — what actually landed — with
 * `amountRequested` struck through when a fee or a discount moved it, so the
 * figure the user sees is the figure their wallet changed by.
 */
export function PaymentRow({ row }: { row: WalletPaymentRow }) {
  const { lang, t } = useLocale();
  const [expanded, setExpanded] = useState(false);

  const status = paymentTone(row);
  const gateway = GATEWAY_TONES[row.gateway?.source ?? "none"];
  const StatusIcon = status.icon;
  const money = (amount: string) => formatMoney(amount, row.currencyCode, { lang, t });
  const when = formatInstant(row.createdAt, lang);
  const expiresAt = formatInstant(row.expiresAt, lang);
  const adjusted = row.amountRequested !== row.amountCredited;
  const credited = row.status === "success";

  return (
    <ExpandableRow
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      // Every attempt has at least its requested amount and its gateway to show.
      canExpand
      details={
        <>
          <DetailItem
            icon={Coins}
            label={t("common", F.detail.requested)}
            value={money(row.amountRequested)}
          />
          {isSet(row.fee) && (
            <DetailItem icon={CreditCard} label={t("common", F.detail.fee)} value={money(row.fee)} />
          )}
          {isSet(row.tax) && row.taxRatePercent !== null && (
            <DetailItem
              icon={Landmark}
              label={t("common", F.detail.tax, { rate: row.taxRatePercent })}
              value={money(row.tax)}
            />
          )}
          {isSet(row.discount) && (
            <DetailItem
              icon={Percent}
              label={t("common", F.detail.discount)}
              value={money(row.discount)}
              className="border-gold/20 bg-gold-bg"
              valueClassName="text-gold"
            />
          )}
          <DetailItem
            icon={Wallet}
            label={t("common", F.detail.credited)}
            value={money(row.amountCredited)}
          />
          {row.gateway && (
            <DetailItem
              icon={Landmark}
              label={t("common", F.detail.gateway)}
              value={row.gateway.displayName}
            />
          )}
          {/* What the gateway was actually asked for, in its own minor units, and
              the rate that produced it — frozen at intent (ADR-0019). */}
          <DetailItem
            icon={Coins}
            label={t("common", F.detail.charged)}
            value={row.charge.amountMinor}
            ltr
          />
          {row.charge.rate && (
            <DetailItem icon={Percent} label={t("common", F.detail.rate)} value={row.charge.rate} ltr />
          )}
          {row.referenceId && (
            <DetailItem
              icon={Hash}
              label={t("common", F.detail.reference)}
              value={row.referenceId}
              copyable
              ltr
            />
          )}
          {row.trackingCode && (
            <DetailItem
              icon={Receipt}
              label={t("common", F.detail.trackingCode)}
              value={row.trackingCode}
              copyable
              ltr
            />
          )}
          {row.cardPanMasked && (
            <DetailItem icon={CreditCard} label={t("common", F.detail.card)} value={row.cardPanMasked} ltr />
          )}
          {row.failureCode && (
            <DetailItem
              icon={AlertTriangle}
              label={t("common", F.detail.failureCode)}
              value={row.failureCode}
              ltr
              className="border-error-border bg-error-bg"
              valueClassName="text-error"
            />
          )}
          {/* A verifying payment's clock no longer closes it (F-092-x). */}
          {expiresAt && row.status === "pending" && !row.verifying && (
            <DetailItem icon={TimerOff} label={t("common", F.detail.expiresAt)} value={expiresAt} />
          )}
        </>
      }
    >
      <div className="grid grid-cols-12 items-center gap-3">
        <div
          className={`col-span-2 flex h-10 w-10 items-center justify-center rounded-2xl border md:col-span-1 ${status.className}`}
        >
          <StatusIcon size={18} aria-hidden />
        </div>

        <div className="col-span-10 min-w-0 md:col-span-4">
          <p className="truncate text-sm font-bold text-text-primary">
            {row.gateway?.displayName ?? t("common", F.gatewaySource.none)}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-text-secondary" dir="ltr">
            {row.trackingCode ?? row.id}
          </p>
        </div>

        <div className="col-span-6 flex flex-col md:col-span-2 md:items-start">
          {adjusted && (
            <span dir="ltr" className="text-[10px] text-text-secondary line-through">
              {money(row.amountRequested)}
            </span>
          )}
          <span
            dir="ltr"
            className={`text-sm font-bold tracking-tight ${credited ? "text-primary" : "text-text-secondary"}`}
          >
            {money(row.amountCredited)}
          </span>
        </div>

        <div className="col-span-6 flex flex-col items-end gap-1 md:col-span-2 md:items-center">
          {when && (
            <span dir="ltr" className="font-mono text-[11px] text-text-primary">
              {when}
            </span>
          )}
          <Badge icon={status.icon} label={t("common", status.labelKey)} className={status.className} />
        </div>

        <div className="col-span-12 hidden justify-end md:col-span-3 md:flex">
          <Badge
            icon={gateway.icon}
            label={t("common", gateway.labelKey)}
            className={gateway.className}
            hideLabelBelowLg
          />
        </div>
      </div>
    </ExpandableRow>
  );
}
