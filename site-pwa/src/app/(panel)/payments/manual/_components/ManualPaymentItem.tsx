"use client";

import { useState } from "react";
import { Ban, KeyRound, Loader2, SearchCheck, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, type ManualAnswer, type VerifyingPayment } from "@/lib/billing-api";
import { Button } from "../../../_components/kit";
import { formatInstant } from "../../../_lib/datetime";
import { formatMoney } from "../../../_lib/money";
import {
  MANUAL_KEYS as K,
  OUTCOME_KEYS,
  canAttachAuthority,
  canConfirmByHand,
  canRejectByHand,
  stateBadges,
  type StateBadge,
} from "../_lib/manual-confirm";
import { judgedWithoutAsking, referenceOf, rejectChoice } from "../_lib/transfer-review";
import { AuthorityForm, ConfirmForm, RejectForm } from "./ManualForms";
import { TransferDetails } from "./TransferDetails";

type OpenForm = "authority" | "confirm" | "reject" | null;

/**
 * One open payment. A gateway's is asked first and judged by hand only when
 * the gateway could not say (ADR-0044 decision 6); a manual transfer has no
 * gateway, so it is judged at once by its proof (F-803-k).
 */
export function ManualPaymentItem({ row, onSettled }: { row: VerifyingPayment; onSettled: (answer: ManualAnswer) => Promise<void> }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ManualAnswer | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenForm>(null);

  const run = async (call: () => Promise<ManualAnswer>) => {
    setBusy(true);
    setActionError(null);
    try {
      const out = await call();
      setAnswer(out);
      if (out.outcome !== "unsettled") {
        setOpen(null);
        await onSettled(out);
      }
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const direct = judgedWithoutAsking(row);
  const outcome = answer?.outcome ?? null;
  const mayConfirm = direct || canConfirmByHand(outcome);
  const mayReject = direct || canRejectByHand(outcome);
  const settledOutcome = answer && answer.outcome !== "unsettled";

  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Summary row={row} />
        <div className="flex items-center gap-2">
          {!direct && (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => billingApi.manualInquire(row.id))}
              icon={busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <SearchCheck size={14} aria-hidden />}
            >
              {t("common", busy ? K.inquiring : K.inquire)}
            </Button>
          )}
          {canAttachAuthority(row) && open !== "authority" && (
            <Button size="sm" disabled={busy} onClick={() => setOpen("authority")} icon={<KeyRound size={14} aria-hidden />}>
              {t("common", K.attachAuthority)}
            </Button>
          )}
          {mayConfirm && open !== "confirm" && (
            <Button variant={direct ? "primary" : undefined} size="sm" disabled={busy} onClick={() => setOpen("confirm")}>
              {t("common", K.confirmByHand)}
            </Button>
          )}
          {mayReject && open !== "reject" && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setOpen("reject")}
              icon={<Ban size={14} aria-hidden />}
              className="text-error hover:text-error hover:bg-error-bg"
            >
              {t("common", K.rejectByHand)}
            </Button>
          )}
        </div>
      </div>

      {row.transfer && <TransferDetails row={row} transfer={row.transfer} />}

      {answer && (
        <p role="status" className={`text-xs font-bold ${settledOutcome ? "text-primary" : "text-text-primary"}`}>
          {t("common", OUTCOME_KEYS[answer.outcome])}
          {answer.gatewayStatus && (
            <span dir="ltr" className="ms-2 font-mono font-normal text-text-secondary">
              ({answer.gatewayStatus})
            </span>
          )}
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-xs font-bold text-error">
          {actionError}
        </p>
      )}

      {open === "authority" && canAttachAuthority(row) && (
        <AuthorityForm
          busy={busy}
          onCancel={() => setOpen(null)}
          onSubmit={(authority) => {
            setOpen(null);
            void run(() => billingApi.manualAttachAuthority(row.id, authority));
          }}
        />
      )}
      {open === "confirm" && mayConfirm && (
        <ConfirmForm
          busy={busy}
          initialReference={row.transfer ? referenceOf(row.transfer.kind, row.transfer.proof) : ""}
          onCancel={() => setOpen(null)}
          onSubmit={(body) => void run(() => billingApi.manualConfirm(row.id, body))}
        />
      )}
      {open === "reject" && mayReject && (
        <RejectForm
          busy={busy}
          mayReturn={rejectChoice(row) === "may_return"}
          onCancel={() => setOpen(null)}
          onSubmit={({ reason, resubmit }) => void run(() => billingApi.manualReject(row.id, reason, resubmit))}
        />
      )}
    </li>
  );
}

/** What the payment is, where it stands, and the ids a reviewer may need to look it up elsewhere. */
function Summary({ row }: { row: VerifyingPayment }) {
  const { lang, t } = useLocale();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
        <span dir="ltr">{formatMoney(row.amountCredited, row.currencyCode, { lang, t })}</span>
        {row.gatewayName && <span className="text-xs font-medium text-text-secondary">{row.gatewayName}</span>}
        {stateBadges(row).map((badge) => (
          <Badge key={badge} badge={badge} />
        ))}
      </span>
      <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        <span>
          {t("common", K.createdAt)}: <span dir="ltr">{formatInstant(row.createdAt, lang)}</span>
        </span>
        <span>{t("common", K.attempts, { count: String(row.verifyAttempts) })}</span>
        {row.nextVerifyAt && (
          <span>
            {t("common", K.nextCheck)}: <span dir="ltr">{formatInstant(row.nextVerifyAt, lang)}</span>
          </span>
        )}
      </span>
      <span className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-3xs text-text-secondary" dir="ltr">
        {row.authority && <span>{t("common", K.authority)}: {row.authority}</span>}
        <span>{t("common", K.user)}: {row.userId}</span>
        {row.tenantId && <span>{t("common", K.tenant)}: {row.tenantId}</span>}
      </span>
    </div>
  );
}

/** A state badge. Theme tokens only; a badge that asks for a person reads as an alert. */
function Badge({ badge }: { badge: StateBadge }) {
  const { t } = useLocale();
  const alert = badge === "flagged" || badge === "noAuthority";
  return (
    <span
      className={
        alert
          ? "inline-flex items-center gap-1 rounded-full border border-error-border bg-error-bg px-2 py-0.5 text-3xs font-bold text-error"
          : "rounded-full border border-primary/20 bg-leaf-bg px-2 py-0.5 text-3xs font-bold text-primary"
      }
    >
      {alert && <TriangleAlert size={10} aria-hidden />}
      {t("common", K.state[badge])}
    </span>
  );
}
