"use client";

import { useLocale } from "@/context/LocaleContext";
import type { TransferStatus } from "@/lib/billing-api";
import { AnimatedNumber } from "../../../_components/kit";
import { CopyButton } from "../../../_components/transfer/CopyButton";
import { formatMoney, rialInTomanWords } from "../../../_lib/money";
import { fromMinor } from "../../../financial/deposit/_lib/deposit-amount";
import { PAY_KEYS } from "../_lib/transfer-page";

/**
 * The one figure the payer must not get wrong (contract principle 2): the
 * largest on the page, counted once on arrival, copied in one tap as plain
 * Latin digits for the bank's form, and a rial amount said in toman words.
 * The count ends on billing's exact string, never on a float's rounding.
 */
export function ExactAmount({ transfer }: { transfer: Pick<TransferStatus, "amountMinor" | "currencyCode" | "decimals"> }) {
  const { lang, t } = useLocale();
  const exact = fromMinor(transfer.amountMinor, transfer.decimals) ?? transfer.amountMinor;
  const money = (amount: string | number) => formatMoney(amount, transfer.currencyCode, { lang, t }, { decimals: transfer.decimals });
  const target = Number(exact);
  const words = rialInTomanWords(exact, { lang, t });

  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <p className="text-xs font-bold text-text-secondary">{t("common", PAY_KEYS.amount.label)}</p>
      <div className="flex items-center gap-2">
        <span dir="ltr" className="text-3xl font-black tracking-tight text-text-primary sm:text-4xl">
          {Number.isFinite(target) ? <AnimatedNumber value={target} format={(n) => (n >= target ? money(exact) : money(n))} /> : money(exact)}
        </span>
        <CopyButton value={exact} label={t("common", PAY_KEYS.amount.copy)} copiedLabel={t("common", PAY_KEYS.amount.copied)} iconOnly />
      </div>
      {words && <p className="text-xs text-text-secondary">{t("common", PAY_KEYS.amount.words, { words })}</p>}
    </div>
  );
}
