"use client";

import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { AdminLottery } from "@/lib/engagement-api";
import { adminStatusKey, refusalKey } from "../_lib/lottery-admin";

/** The refusal's own sentence, else the generic answer for that error. */
export function useLotteryMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

const TONE: Record<AdminLottery["status"], string> = {
  draft: "bg-bg-inner text-text-secondary",
  published: "bg-[var(--leaf-bg)] text-primary",
  frozen: "bg-bg-inner text-text-primary",
  drawn: "bg-[var(--leaf-bg)] text-primary",
  cancelled: "bg-bg-inner text-text-secondary line-through",
};

export function StatusPill({ lottery }: { lottery: Pick<AdminLottery, "status" | "closesAt"> }) {
  const { t } = useLocale();
  return <span className={`rounded-full px-2 py-0.5 text-2xs font-bold ${TONE[lottery.status]}`}>{t("common", adminStatusKey(lottery, new Date()))}</span>;
}
