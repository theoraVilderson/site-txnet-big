"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Banknote, CheckCheck, Loader2, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { ApiError } from "@/lib/api-error";
import type { TransferStatus } from "@/lib/billing-api";
import { fadeRise } from "@/lib/motion";
import { Button, Card, PageHeader } from "../../../_components/kit";
import { transferKind } from "../../../_components/transfer/transfer-kinds";
import { useNow } from "../_hooks/useNow";
import { useTransfer } from "../_hooks/useTransfer";
import { PAY_KEYS as K, countdownOf, phaseOf, stepOf, type TransferPhase } from "../_lib/transfer-page";
import { CountdownRing } from "./CountdownRing";
import { ExactAmount } from "./ExactAmount";
import { ProofForm } from "./ProofForm";
import { CheckingPanel, ClosedPanel, CreditedPanel } from "./TransferOutcome";
import { TransferStepper } from "./TransferStepper";

const NOT_FOUND = 404;

/**
 * `/payment/transfer/[paymentId]` (F-803-i, contract.manual-transfer.md "The
 * pay page"): one page for every manual kind, the kind drawing the middle.
 * Billing's row decides the phase; the page only adds whether the payer has
 * said they paid, which opens the proof form early.
 */
export function TransferPayView({ paymentId }: { paymentId: string }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const { transfer, error, isLoading, reload } = useTransfer(paymentId);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-4 sm:p-6">
      <PageHeader icon={Banknote} title={t("common", K.title)} />
      {transfer ? (
        <TransferBody transfer={transfer} paymentId={paymentId} reload={reload} />
      ) : isLoading ? (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {t("common", K.loading)}
        </p>
      ) : (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <p role="alert" className="text-sm font-bold text-error">
            {error instanceof ApiError && error.status === NOT_FOUND ? t("common", K.notFound) : errorMessage(error)}
          </p>
          <Button variant="quiet" size="sm" onClick={() => void reload()} icon={<RotateCw size={14} aria-hidden />}>
            {t("common", K.retry)}
          </Button>
        </Card>
      )}
    </div>
  );
}

function TransferBody({ transfer, paymentId, reload }: { transfer: TransferStatus; paymentId: string; reload: () => Promise<void> }) {
  const { t } = useLocale();
  const level = useMotionLevel();
  const [saidPaid, setSaidPaid] = useState(false);
  const open = transfer.status === "pending" && !transfer.proofSubmittedAt;
  const now = useNow(open);
  const phase = phaseOf(transfer, now);
  const kind = transferKind(transfer.kind);

  return (
    <>
      <TransferStepper active={stepOf(phase, saidPaid)} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={phaseGroup(phase)} variants={fadeRise(level)} initial="hidden" animate="shown" exit="hidden" className="flex flex-col gap-6">
          {(phase === "send" || phase === "late") && (
            <>
              <Card className="flex flex-col items-center gap-4">
                <CountdownRing countdown={countdownOf(transfer.windowEndsAt, transfer.windowMinutes, now)} />
                {phase === "late" && <p className="text-center text-sm font-bold text-warning">{t("common", K.countdown.over)}</p>}
                <ExactAmount transfer={transfer} />
              </Card>
              <Card className="flex flex-col gap-4">
                <h2 className="text-sm font-bold text-text-secondary">{t("common", K.destination)}</h2>
                <kind.Destination destination={transfer.destination} />
              </Card>
              <Card>
                {phase === "send" && !saidPaid ? (
                  <Button variant="primary" fullWidth icon={<CheckCheck size={16} aria-hidden />} onClick={() => setSaidPaid(true)}>
                    {t("common", K.paid)}
                  </Button>
                ) : (
                  <ProofForm paymentId={paymentId} requiredProof={transfer.requiredProof} onSent={() => void reload()} />
                )}
              </Card>
            </>
          )}
          {phase === "checking" && (
            <Card>
              <CheckingPanel transfer={transfer} />
            </Card>
          )}
          {phase === "credited" && (
            <Card className="flex flex-col items-center gap-4">
              <CountdownRing countdown={countdownOf(transfer.windowEndsAt, transfer.windowMinutes, now)} credited />
              <CreditedPanel />
            </Card>
          )}
          {phase === "closed" && (
            <Card>
              <ClosedPanel status={transfer.status} />
            </Card>
          )}
        </motion.div>
      </AnimatePresence>
    </>
  );
}

/** `send` and `late` are one screen whose ring changes; every other phase swaps the screen. */
const phaseGroup = (phase: TransferPhase) => (phase === "late" ? "send" : phase);
