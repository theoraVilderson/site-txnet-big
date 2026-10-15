"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION } from "@/lib/motion";
import { bankColors, cardGroups, OTHER_BANK } from "./banks";

const T = FrontendI18nKeys.common.transfer;

/** The bank's name, `other`'s when the id is in no row of the table. */
export function useBankName(): (bankId: string) => string {
  const { t } = useLocale();
  return (bankId) => t("common", bankId in T.banks ? T.banks[bankId as keyof typeof T.banks] : T.banks[OTHER_BANK]);
}

interface BankCardProps {
  /** Latin digits, as many as are typed so far. */
  digits: string;
  holderName: string;
  bankId: string;
}

/**
 * A bank card drawn in CSS at ISO/IEC 7810 ID-1's 85.6 : 54 (contract.manual-transfer.md
 * "Card-to-card"): the bank's colour pair as a gradient — the brand's own for
 * a BIN in no row — its name in the logo slot, a chip, the number in 4-4-4-4
 * and the holder. The seller's editor fills it as they type (F-803-g); the pay
 * page draws the same card for the payer (F-803-i). A bank that resolves fades
 * in rather than snapping, and under reduced motion only the fade is left (M3).
 *
 * The number is always Latin digits and `ltr`, as the bank's own form takes it.
 */
export function BankCard({ digits, holderName, bankId }: BankCardProps) {
  const bankName = useBankName();
  const level = useMotionLevel();
  const colors = bankColors(bankId);
  const fade = { duration: level === "full" ? DURATION.base : DURATION.fast };
  return (
    <div className="relative aspect-[856/540] w-full max-w-sm overflow-hidden rounded-2xl text-white shadow-lg" dir="ltr">
      <AnimatePresence initial={false}>
        <motion.div
          key={bankId}
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fade}
          className={`absolute inset-0 ${colors ? "" : "bg-[image:var(--card-gradient)]"}`}
          // The table's colours are data from the bank's brand, not the panel's theme (C-31 holds the panel's own).
          style={colors ? { backgroundImage: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})` } : undefined}
        />
      </AnimatePresence>
      <div className="relative flex h-full flex-col justify-between p-[6%]">
        <div className="flex items-start justify-between gap-2">
          <motion.span key={bankId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={fade} className="flex items-center gap-2">
            <span aria-hidden className="grid size-8 place-items-center rounded-full bg-white/20 text-sm font-bold">
              {bankName(bankId).slice(0, 1)}
            </span>
            <span className="text-sm font-bold" dir="auto">
              {bankName(bankId)}
            </span>
          </motion.span>
        </div>
        <span aria-hidden className="h-[18%] w-[15%] rounded-md bg-gradient-to-br from-white/70 to-white/30" />
        <p className="whitespace-pre font-mono text-lg font-bold tracking-wider sm:text-xl">{cardGroups(digits).join("  ")}</p>
        <p className="truncate text-sm font-bold opacity-90" dir="auto">
          {holderName || " "}
        </p>
      </div>
    </div>
  );
}
