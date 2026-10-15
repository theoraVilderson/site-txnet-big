"use client";

import { useState, type FormEvent } from "react";
import { Send } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { ApiError } from "@/lib/api-error";
import { billingApi } from "@/lib/billing-api";
import { Button, Field, Input } from "../../../_components/kit";
import { PAID_AT_FIELD, RECEIPT_FIELD } from "../../../_components/transfer/proof-fields";
import { PAY_KEYS, PROOF_REFUSAL_KEYS, proofBody, proofErrors, refusedFields, type ProofErrors } from "../_lib/transfer-page";
import { ReceiptDrop } from "./ReceiptDrop";

const K = PAY_KEYS.proof;
const LABELS: Readonly<Record<string, string>> = FrontendI18nKeys.common.transfer.proof;
const HINTS: Readonly<Record<string, string>> = K.hints;
const REFUSAL: Readonly<Record<string, string>> = FrontendI18nKeys.common.transfer.refusal;

/** How each typed field is entered: a card's codes on the number pad, a time from the picker, the rest as text. */
const INPUT: Readonly<Record<string, { type?: string; inputMode?: "numeric"; ltr: boolean }>> = {
  trackingCode: { inputMode: "numeric", ltr: true },
  sourceCardLast4: { inputMode: "numeric", ltr: true },
  [PAID_AT_FIELD]: { type: "datetime-local", ltr: true },
  txHash: { ltr: true },
};

/**
 * The proof (contract "Proof"): only the fields the seller required, the
 * receipt as a drop zone, each field's refusal shown once it was touched or
 * billing named it, and submit disabled until every field would pass. One
 * proof per payment until a person sends it back, so `onSent` re-reads.
 */
export function ProofForm({ paymentId, requiredProof, onSent }: { paymentId: string; requiredProof: readonly string[]; onSent: () => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [receiptKey, setReceiptKey] = useState<string | null>(null);
  const [refused, setRefused] = useState<ProofErrors>({});
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const errors = proofErrors(requiredProof, draft, receiptKey);
  const ready = Object.keys(errors).length === 0;
  const shown = (id: string) => refused[id] ?? (touched.has(id) ? errors[id] : undefined);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    setFormError(null);
    try {
      await billingApi.submitTransferProof(paymentId, proofBody(requiredProof, draft, receiptKey));
      onSent();
    } catch (e) {
      setRefused(refusedFields(e));
      const reason = e instanceof ApiError ? e.reason : undefined;
      setFormError(reason && reason in PROOF_REFUSAL_KEYS ? t("common", PROOF_REFUSAL_KEYS[reason]) : errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const type = (id: string, value: string) => {
    setDraft((d) => ({ ...d, [id]: value }));
    setTouched((s) => new Set(s).add(id));
    setRefused((r) => {
      const rest = { ...r };
      delete rest[id];
      return rest;
    });
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-bold text-text-primary">{t("common", K.title)}</h2>
        <p className="text-xs text-text-secondary">{t("common", K.hint)}</p>
      </div>
      {requiredProof.map((id) =>
        id === RECEIPT_FIELD ? (
          <Field key={id} label={t("common", LABELS[id])} error={refused[id] ? t("common", REFUSAL[refused[id]!]) : undefined}>
            <ReceiptDrop paymentId={paymentId} onUploaded={setReceiptKey} invalid={Boolean(refused[id])} />
          </Field>
        ) : (
          <Field
            key={id}
            label={id in LABELS ? t("common", LABELS[id]) : id}
            hint={id in HINTS ? t("common", HINTS[id]) : undefined}
            error={shown(id) ? t("common", REFUSAL[shown(id)!]) : undefined}
          >
            <Input
              type={INPUT[id]?.type}
              inputMode={INPUT[id]?.inputMode}
              dir={INPUT[id]?.ltr ? "ltr" : undefined}
              value={draft[id] ?? ""}
              onChange={(e) => type(id, e.target.value)}
              onBlur={() => setTouched((s) => new Set(s).add(id))}
            />
          </Field>
        ),
      )}
      {formError && (
        <p role="alert" className="text-xs font-bold text-error">
          {formError}
        </p>
      )}
      <Button variant="primary" type="submit" disabled={!ready} loading={sending} icon={<Send size={16} aria-hidden />}>
        {t("common", sending ? K.sending : K.submit)}
      </Button>
    </form>
  );
}
