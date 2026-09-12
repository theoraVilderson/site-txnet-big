"use client";

import { useState } from "react";
import { Hash, Wallet } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { WalletLedgerRow } from "@/lib/billing-api";
import { BASE_CURRENCY, formatMoney } from "../../_lib/money";
import { formatInstant } from "../../_lib/datetime";
import { DIRECTION_TONES, reasonLabelKey } from "../_lib/tones";
import { Badge } from "./Badge";
import { DetailItem } from "./DetailItem";
import { ExpandableRow } from "./ExpandableRow";

const F = FrontendI18nKeys.common.financial;

/**
 * One movement of money (F-093-d).
 *
 * There is no status here and there is no title: a ledger row exists because
 * money moved, and what it is called is its `reasonType`
 * (`domains/billing/contract.history.md`). A `pending` top-up is not on this
 * list at all — it is a payment attempt, and it is on the other one.
 *
 * `balanceAfter` is printed as the ledger wrote it. Nothing on this page adds
 * an amount to a balance or walks one backwards, which is the single thing
 * legacy's version of this row did wrong (F-092-n's note).
 */
export function LedgerRow({ row }: { row: WalletLedgerRow }) {
  const { lang, t } = useLocale();
  const [expanded, setExpanded] = useState(false);

  const tone = DIRECTION_TONES[row.direction];
  const credit = row.direction === "credit";
  const Icon = tone.icon;
  const reasonKey = reasonLabelKey(row.reasonType);
  const title = reasonKey ? t("common", reasonKey) : row.reasonType;
  const money = (amount: string) => formatMoney(amount, BASE_CURRENCY, { lang, t });
  const when = formatInstant(row.createdAt, lang);

  return (
    <ExpandableRow
      expanded={expanded}
      onToggle={() => setExpanded((open) => !open)}
      canExpand={row.referenceId !== null}
      details={
        <>
          {row.referenceId && (
            <DetailItem icon={Hash} label={t("common", F.detail.reference)} value={row.referenceId} copyable ltr />
          )}
          <DetailItem
            icon={Wallet}
            label={t("common", F.detail.balanceAfter)}
            value={money(row.balanceAfter)}
            valueClassName="text-gold"
          />
        </>
      }
    >
      <div className="grid grid-cols-12 items-center gap-3">
        <div
          className={`col-span-2 flex h-10 w-10 items-center justify-center rounded-2xl border md:col-span-1 ${tone.className}`}
        >
          <Icon size={18} aria-hidden />
        </div>

        <div className="col-span-10 min-w-0 md:col-span-4">
          <p className="truncate text-sm font-bold text-text-primary">{title}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-text-secondary" dir="ltr">
            {row.id}
          </p>
        </div>

        <div className="col-span-6 flex flex-col md:col-span-2 md:items-start">
          <span
            dir="ltr"
            className={`text-sm font-bold tracking-tight ${credit ? "text-primary" : "text-error"}`}
          >
            {credit ? "+" : "−"} {money(row.amount)}
          </span>
          <span className="md:hidden">
            <Badge icon={tone.icon} label={t("common", tone.labelKey)} className={tone.className} />
          </span>
        </div>

        <div className="col-span-6 flex flex-col items-end gap-1 md:col-span-2 md:items-center">
          {when && (
            <span dir="ltr" className="font-mono text-[11px] text-text-primary">
              {when}
            </span>
          )}
          <span className="hidden md:block">
            <Badge icon={tone.icon} label={t("common", tone.labelKey)} className={tone.className} />
          </span>
        </div>

        <div className="col-span-12 hidden flex-col items-end md:col-span-3 md:flex">
          <span className="text-[10px] text-text-secondary">{t("common", F.detail.balanceAfter)}</span>
          <span dir="ltr" className="font-mono text-xs font-medium text-gold">
            {money(row.balanceAfter)}
          </span>
        </div>
      </div>
    </ExpandableRow>
  );
}
