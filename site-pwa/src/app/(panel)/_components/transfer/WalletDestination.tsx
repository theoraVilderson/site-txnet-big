"use client";

import { QRCodeSVG } from "qrcode.react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Alert } from "../kit";
import { CopyButton } from "./CopyButton";
import type { DestinationProps } from "./transfer-kind";
import { addressSegments } from "./wallet-address";

const W = FrontendI18nKeys.common.transferPay.wallet;

/** The QR's side in CSS pixels: scannable from a second phone held at arm's length. */
const QR_SIZE = 184;
/** The asset's mark over the QR's centre, as a share of its side: inside what level `H` (30 %) recovers. */
const MARK_SHARE = 0.24;

/**
 * A wallet destination for its payer (F-803-j, contract.manual-transfer.md
 * "Wallet"): the address's QR with the asset at its centre, the address with
 * its first and last six characters set apart to compare with the wallet's
 * screen — what clipboard-swapping malware cannot forge — and copy as the
 * primary button. The seller's network is said verbatim in the warning tone,
 * since a transfer on another chain is lost; a memo, when set, is a second
 * copy row marked required. The exact amount, in the asset and its decimals,
 * is the page's `ExactAmount` above this.
 */
export function WalletDestination({ destination }: DestinationProps) {
  const { t } = useLocale();
  const address = String(destination.address ?? "").trim();
  const asset = String(destination.asset ?? "");
  const network = String(destination.network ?? "");
  const memo = destination.memo ? String(destination.memo) : null;

  return (
    <div className="flex flex-col items-center gap-4">
      <figure className="relative rounded-3xl border border-card-border bg-white p-3 shadow-sm">
        <QRCodeSVG value={address} size={QR_SIZE} level="H" aria-label={t("common", W.qr, { asset })} />
        <span
          aria-hidden
          className="absolute inset-0 m-auto grid place-items-center rounded-full border-4 border-white bg-primary font-mono text-3xs font-black text-on-accent"
          style={{ width: QR_SIZE * MARK_SHARE, height: QR_SIZE * MARK_SHARE }}
        >
          {asset}
        </span>
      </figure>
      {network && (
        <Alert tone="warning" title={t("common", W.onlyOn, { network })} className="w-full max-w-sm">
          {t("common", W.onlyOnWhy)}
        </Alert>
      )}
      <SegmentedAddress address={address} />
      <CopyButton value={address} label={t("common", W.copyAddress)} copiedLabel={t("common", W.copied)} variant="primary" className="w-full max-w-sm" />
      {memo && <MemoRow memo={memo} />}
      {/* TODO(F-803-f): the confirmations bar, n / required from `transfer_seen`, once a watcher sends it. */}
    </div>
  );
}

function SegmentedAddress({ address }: { address: string }) {
  const { t } = useLocale();
  const { head, middle, tail } = addressSegments(address);
  return (
    <div className="flex w-full max-w-sm flex-col gap-1.5 text-center">
      <p dir="ltr" translate="no" className="break-all font-mono text-sm leading-6 text-text-secondary">
        <strong className="font-black text-text-primary">{head}</strong>
        {middle.map((group) => (
          <span key={group.at} className="ms-1">
            {group.text}
          </span>
        ))}
        {tail && <strong className="ms-1 font-black text-text-primary">{tail}</strong>}
      </p>
      <p className="text-xs text-text-secondary">{t("common", W.compare)}</p>
    </div>
  );
}

function MemoRow({ memo }: { memo: string }) {
  const { t } = useLocale();
  const label = t("common", W.memo);
  return (
    <div className="flex w-full max-w-sm items-center justify-between gap-3 rounded-2xl border border-error-border p-3">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-xs text-text-secondary">
          {label}
          <span className="font-bold text-error">{t("common", W.memoRequired)}</span>
        </p>
        <p dir="ltr" translate="no" className="break-all font-mono text-sm font-bold text-text-primary">
          {memo}
        </p>
        <p className="text-xs text-text-secondary">{t("common", W.memoWhy)}</p>
      </div>
      <CopyButton value={memo} label={`${t("common", W.copy)} ${label}`} copiedLabel={t("common", W.copied)} iconOnly className="shrink-0" />
    </div>
  );
}
