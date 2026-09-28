"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, KeyRound, Loader2, RotateCw, SearchCheck, ShieldCheck, TriangleAlert } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { billingApi, type ManualAnswer, type VerifyingPayment } from "@/lib/billing-api";
import { formatMoney } from "../../../_lib/money";
import { formatInstant } from "../../../_lib/datetime";
import {
  MANUAL_KEYS as K,
  OUTCOME_KEYS,
  canAttachAuthority,
  canConfirmByHand,
  canRejectByHand,
  stateBadges,
  validateAuthority,
  validateConfirm,
  validateReject,
  type ConfirmInput,
  type StateBadge,
} from "../_lib/manual-confirm";

/**
 * The manual confirmation screen (F-093-n, ADR-0044 decision 6) — what
 * replaces legacy's off-the-books manual top-up. Since F-093-o it lists every
 * open payment (ADR-0046 decision 7), badged by state, and takes a lost
 * authority by hand.
 *
 * **Inquire, then confirm.** Each payment offers "ask the gateway" first. Only
 * when that answers `unsettled` does the hand-confirm form appear, asking for
 * the gateway's reference number and a reason. Billing asks the gateway once
 * more before it credits, so a payment that settled in between is settled by
 * the gateway, not by the person.
 *
 * Nothing is patched into the list from an answer: after every inquire or
 * confirm the list is read again, because billing decides what the payment
 * became.
 */
export function ManualPaymentsView() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [rows, setRows] = useState<VerifyingPayment[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // The row a settled answer was about leaves the list on reload; its sentence stays here.
  const [notice, setNotice] = useState<ManualAnswer | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await billingApi.manualPayments());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const settled = useCallback(
    async (answer: ManualAnswer) => {
      setNotice(answer);
      await reload();
    },
    [reload],
  );

  useEffect(() => {
    // Every setState in reload runs after its first await, as in `useGateways`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="flex items-center gap-2 text-lg font-bold text-text-primary">
          <ShieldCheck size={18} className="text-primary" aria-hidden />
          {t("common", K.title)}
        </h1>
        <p className="text-xs text-text-secondary">{t("common", K.subtitle)}</p>
      </header>

      {notice && (
        <p role="status" className="rounded-xl border border-card-border bg-card-bg p-3 text-xs font-bold text-text-primary">
          {t("common", OUTCOME_KEYS[notice.outcome])}
          {notice.referenceId && (
            <span dir="ltr" className="ms-2 font-mono font-normal text-text-secondary">
              {notice.referenceId}
            </span>
          )}
        </p>
      )}

      <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm sm:p-6">
        {isLoading ? (
          <p className="flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 size={14} className="animate-spin" aria-hidden />
            {t("common", K.loading)}
          </p>
        ) : error ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p role="alert" className="text-xs font-bold text-error">
              {errorMessage(error)}
            </p>
            <button type="button" onClick={() => void reload()} className="inline-flex items-center gap-1 text-xs font-bold text-primary">
              <RotateCw size={14} aria-hidden />
              {t("common", K.retry)}
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-secondary">{t("common", K.empty)}</p>
        ) : (
          <ul className="divide-y divide-card-border">
            {rows.map((row) => (
              <ManualPaymentItem key={row.id} row={row} onSettled={settled} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ManualPaymentItem({ row, onSettled }: { row: VerifyingPayment; onSettled: (answer: ManualAnswer) => Promise<void> }) {
  const { lang, t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ManualAnswer | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState<ConfirmInput>({ referenceId: "", reason: "" });
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof ConfirmInput, string>>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [authorityOpen, setAuthorityOpen] = useState(false);
  const [authority, setAuthority] = useState("");
  const [authorityError, setAuthorityError] = useState<string | null>(null);
  // F-093-p: rejecting by hand — offered on the same condition as confirming.
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);

  const run = async (call: () => Promise<ManualAnswer>) => {
    setBusy(true);
    setActionError(null);
    try {
      const out = await call();
      setAnswer(out);
      if (out.outcome !== "unsettled") {
        setFormOpen(false);
        setRejectOpen(false);
        await onSettled(out);
      }
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submitAuthority = (event: React.FormEvent) => {
    event.preventDefault();
    const checked = validateAuthority(authority);
    if (!checked.ok) {
      setAuthorityError(checked.error);
      return;
    }
    setAuthorityError(null);
    setAuthorityOpen(false);
    void run(() => billingApi.manualAttachAuthority(row.id, checked.authority));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const checked = validateConfirm(form);
    if (!checked.ok) {
      setFormErrors(checked.errors);
      return;
    }
    setFormErrors({});
    void run(() => billingApi.manualConfirm(row.id, checked.body));
  };

  const submitReject = (event: React.FormEvent) => {
    event.preventDefault();
    const checked = validateReject(rejectReason);
    if (!checked.ok) {
      setRejectError(checked.error);
      return;
    }
    setRejectError(null);
    void run(() => billingApi.manualReject(row.id, checked.reason));
  };

  const money = formatMoney(row.amountCredited, row.currencyCode, { lang, t });
  const settledOutcome = answer && answer.outcome !== "unsettled";

  return (
    <li className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
            <span dir="ltr">{money}</span>
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
          <span className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-text-secondary" dir="ltr">
            {row.authority && <span>{t("common", K.authority)}: {row.authority}</span>}
            <span>{t("common", K.user)}: {row.userId}</span>
            {row.tenantId && <span>{t("common", K.tenant)}: {row.tenantId}</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => billingApi.manualInquire(row.id))}
            className="inline-flex items-center gap-1 rounded-xl bg-primary px-3 py-2 text-xs font-bold text-text-on-accent disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <SearchCheck size={14} aria-hidden />}
            {t("common", busy ? K.inquiring : K.inquire)}
          </button>
          {canAttachAuthority(row) && !authorityOpen && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setAuthorityOpen(true)}
              className="inline-flex items-center gap-1 rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
            >
              <KeyRound size={14} aria-hidden />
              {t("common", K.attachAuthority)}
            </button>
          )}
          {canConfirmByHand(answer?.outcome ?? null) && !formOpen && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setFormOpen(true)}
              className="rounded-xl border border-card-border px-3 py-2 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50"
            >
              {t("common", K.confirmByHand)}
            </button>
          )}
          {canRejectByHand(answer?.outcome ?? null) && !rejectOpen && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setRejectOpen(true)}
              className="inline-flex items-center gap-1 rounded-xl border border-error-border px-3 py-2 text-xs font-bold text-error hover:bg-error-bg disabled:opacity-50"
            >
              <Ban size={14} aria-hidden />
              {t("common", K.rejectByHand)}
            </button>
          )}
        </div>
      </div>

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

      {authorityOpen && canAttachAuthority(row) && (
        <form onSubmit={submitAuthority} className="flex flex-col gap-3 rounded-2xl border border-card-border bg-bg-inner p-4">
          <p className="text-sm font-bold text-text-primary">{t("common", K.authorityForm.title)}</p>
          <p className="text-xs leading-5 text-text-secondary">{t("common", K.authorityForm.hint)}</p>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t("common", K.authorityForm.label)}
            <input
              dir="ltr"
              value={authority}
              maxLength={64}
              onChange={(e) => setAuthority(e.target.value)}
              className="rounded-xl border border-card-border bg-card-bg px-3 py-2 font-mono text-sm text-text-primary"
            />
            {authorityError && <span className="text-error">{t("common", authorityError)}</span>}
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-bold text-text-on-accent disabled:opacity-50"
            >
              {t("common", K.authorityForm.submit)}
            </button>
            <button
              type="button"
              onClick={() => setAuthorityOpen(false)}
              className="rounded-xl px-4 py-2 text-xs font-medium text-text-secondary hover:bg-leaf-bg"
            >
              {t("common", K.authorityForm.cancel)}
            </button>
          </div>
        </form>
      )}

      {formOpen && canConfirmByHand(answer?.outcome ?? null) && (
        <form onSubmit={submit} className="flex flex-col gap-3 rounded-2xl border border-card-border bg-bg-inner p-4">
          <p className="text-sm font-bold text-text-primary">{t("common", K.form.title)}</p>
          <p className="text-xs leading-5 text-text-secondary">{t("common", K.form.hint)}</p>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t("common", K.form.referenceId)}
            <input
              dir="ltr"
              value={form.referenceId}
              maxLength={64}
              onChange={(e) => setForm((f) => ({ ...f, referenceId: e.target.value }))}
              className="rounded-xl border border-card-border bg-card-bg px-3 py-2 text-sm text-text-primary"
            />
            {formErrors.referenceId && <span className="text-error">{t("common", formErrors.referenceId)}</span>}
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t("common", K.form.reason)}
            <textarea
              value={form.reason}
              maxLength={500}
              rows={3}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              className="rounded-xl border border-card-border bg-card-bg px-3 py-2 text-sm text-text-primary"
            />
            {formErrors.reason && <span className="text-error">{t("common", formErrors.reason)}</span>}
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-primary px-4 py-2 text-xs font-bold text-text-on-accent disabled:opacity-50"
            >
              {t("common", K.form.submit)}
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded-xl px-4 py-2 text-xs font-medium text-text-secondary hover:bg-leaf-bg"
            >
              {t("common", K.form.cancel)}
            </button>
          </div>
        </form>
      )}

      {rejectOpen && canRejectByHand(answer?.outcome ?? null) && (
        <form onSubmit={submitReject} className="flex flex-col gap-3 rounded-2xl border border-error-border bg-bg-inner p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-error">
            <TriangleAlert size={14} aria-hidden />
            {t("common", K.rejectForm.title)}
          </p>
          <p className="text-xs leading-5 text-text-secondary">{t("common", K.rejectForm.hint)}</p>
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t("common", K.rejectForm.reason)}
            <textarea
              value={rejectReason}
              maxLength={500}
              rows={3}
              onChange={(e) => setRejectReason(e.target.value)}
              className="rounded-xl border border-card-border bg-card-bg px-3 py-2 text-sm text-text-primary"
            />
            {rejectError && <span className="text-error">{t("common", rejectError)}</span>}
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl border border-error-border bg-error-bg px-4 py-2 text-xs font-bold text-error disabled:opacity-50"
            >
              {t("common", K.rejectForm.submit)}
            </button>
            <button
              type="button"
              onClick={() => setRejectOpen(false)}
              className="rounded-xl px-4 py-2 text-xs font-medium text-text-secondary hover:bg-leaf-bg"
            >
              {t("common", K.rejectForm.cancel)}
            </button>
          </div>
        </form>
      )}
    </li>
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
          ? "inline-flex items-center gap-1 rounded-full border border-error-border bg-error-bg px-2 py-0.5 text-[10px] font-bold text-error"
          : "rounded-full border border-primary/20 bg-leaf-bg px-2 py-0.5 text-[10px] font-bold text-primary"
      }
    >
      {alert && <TriangleAlert size={10} aria-hidden />}
      {t("common", K.state[badge])}
    </span>
  );
}

