"use client";

import { useState } from "react";
import { ExternalLink, ImageIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { TransferReviewReason, TransferView, VerifyingPayment } from "@/lib/billing-api";
import { Badge, Button, type Tone } from "../../../_components/kit";
import { explorerTxUrl } from "../../../_components/transfer/networks";
import { formatInstant } from "../../../_lib/datetime";
import { formatMoney } from "../../../_lib/money";
import { fromMinor } from "../../../financial/deposit/_lib/deposit-amount";
import { MANUAL_KEYS } from "../_lib/manual-confirm";
import { REVIEW_REASON_KEYS, proofRows } from "../_lib/transfer-review";
import { ReceiptLightbox } from "./ReceiptLightbox";

const K = MANUAL_KEYS.transfer;
const PROOF_LABELS: Record<string, string> = FrontendI18nKeys.common.transfer.proof;

/** `proof_only` is the ordinary case (a person checks the account); every other reason is something to look at twice. */
const reasonTone = (reason: TransferReviewReason): Tone => (reason === "proof_only" ? "info" : "warning");

/**
 * What a reviewer judges a manual transfer by (F-803-k): where it was sent,
 * what should have arrived against what the wallet gets, the payer's proof,
 * the receipt and why billing left it to a person.
 */
export function TransferDetails({ row, transfer }: { row: VerifyingPayment; transfer: TransferView }) {
  const { lang, t } = useLocale();
  const [receiptOpen, setReceiptOpen] = useState(false);
  const expected = fromMinor(transfer.expectedAmountMinor, transfer.decimals);
  const rows = proofRows(transfer.kind, transfer.proof);

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-card-border bg-bg-inner p-4">
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
        <Fact label={t("common", K.destination)}>{transfer.destinationLabel}</Fact>
        <Fact label={t("common", K.expected)} ltr>
          {expected ? formatMoney(expected, transfer.currencyCode, { lang, t }, { decimals: transfer.decimals }) : transfer.expectedAmountMinor}
        </Fact>
        <Fact label={t("common", K.credits)} ltr>
          {formatMoney(row.amountCredited, row.currencyCode, { lang, t })}
        </Fact>
      </dl>

      {transfer.reviewReason && (
        <Badge tone={reasonTone(transfer.reviewReason)} className="self-start">
          {t("common", REVIEW_REASON_KEYS[transfer.reviewReason])}
        </Badge>
      )}

      {transfer.proof === null ? (
        <p className="text-xs text-text-secondary">{t("common", K.noProof)}</p>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          {transfer.receiptUrl && (
            <Button size="sm" onClick={() => setReceiptOpen(true)} icon={<ImageIcon size={14} aria-hidden />}>
              {t("common", K.openReceipt)}
            </Button>
          )}
          <dl className="grid flex-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            {rows.map(([id, value]) => (
              <Fact key={id} label={id in PROOF_LABELS ? t("common", PROOF_LABELS[id]) : id} ltr>
                <ProofValue id={id} value={value} network={transfer.network} />
              </Fact>
            ))}
          </dl>
        </div>
      )}

      {transfer.receiptUrl && <ReceiptLightbox key={transfer.receiptUrl} url={transfer.receiptUrl} open={receiptOpen} onClose={() => setReceiptOpen(false)} />}
    </div>
  );
}

function Fact({ label, ltr, children }: { label: string; ltr?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-text-secondary">{label}</dt>
      <dd dir={ltr ? "ltr" : undefined} className="break-all font-bold text-text-primary">
        {children}
      </dd>
    </div>
  );
}

/** A time reads in the reviewer's locale; a hash links to its explorer when the network is known; the rest is as sent. */
function ProofValue({ id, value, network }: { id: string; value: string; network: string | null }) {
  const { lang, t } = useLocale();
  if (id === "paidAt") return <>{formatInstant(value, lang)}</>;
  const explorer = id === "txHash" ? explorerTxUrl(network, value) : null;
  if (!explorer) return <span className="font-mono">{value}</span>;
  return (
    <a href={explorer} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-primary hover:underline">
      {value}
      <ExternalLink size={12} aria-hidden />
      <span className="sr-only">{t("common", K.explorer)}</span>
    </a>
  );
}
