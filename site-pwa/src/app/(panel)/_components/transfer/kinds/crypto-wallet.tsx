"use client";

import { QRCodeSVG } from "qrcode.react";
import { Wallet } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Badge } from "../../kit";
import { TransferField } from "../TransferField";
import { missingFields, type AdminFieldsProps, type DestinationDraft, type TransferKind } from "../transfer-kind";

const T = FrontendI18nKeys.common.transfer;

/** The QR's side in CSS pixels: scannable from a phone held at arm's length. */
const QR_SIZE = 168;
/** An address's ends a list shows — the part a payer compares (contract "Wallet"). */
const SHOWN_CHARS = 6;
/** Billing's `decimals` range: 0..18. */
const DECIMALS = /^\d{1,2}$/;
const MAX_DECIMALS = 18;

function check(draft: DestinationDraft) {
  const errors = missingFields(CRYPTO_WALLET, draft);
  const decimals = (draft.decimals ?? "").trim();
  if (decimals && !(DECIMALS.test(decimals) && Number(decimals) <= MAX_DECIMALS)) errors.decimals = "invalid";
  return errors;
}

const ends = (address: string) =>
  address.length > SHOWN_CHARS * 2 ? `${address.slice(0, SHOWN_CHARS)}…${address.slice(-SHOWN_CHARS)}` : address;

/**
 * The seller's wallet editor (F-803-g): asset, network, address, memo and the
 * asset's decimals — nothing preset (D-60 part 3), the network in the seller's
 * own words. The address's QR is drawn beside the form as it is typed, so the
 * seller can scan it with their own wallet before a payer ever does.
 */
function WalletAdminFields({ fields, onChange, errors }: AdminFieldsProps) {
  const { t } = useLocale();
  const address = (fields.address ?? "").trim();
  return (
    <div className="grid items-start gap-5 sm:grid-cols-[1fr_auto]">
      <div className="grid gap-4 sm:grid-cols-2">
        <TransferField id="asset" fields={fields} onChange={onChange} errors={errors} ltr placeholder="USDT" fold={(raw) => raw.toUpperCase()} />
        <TransferField id="network" fields={fields} onChange={onChange} errors={errors} ltr placeholder="TRC20" />
        <div className="sm:col-span-2">
          <TransferField id="address" fields={fields} onChange={onChange} errors={errors} ltr />
        </div>
        <TransferField id="memo" fields={fields} onChange={onChange} errors={errors} ltr optional />
        <TransferField id="decimals" fields={fields} onChange={onChange} errors={errors} ltr numeric placeholder="6" />
      </div>
      <figure className="flex flex-col items-center gap-2 justify-self-center">
        <div className="rounded-2xl border border-card-border bg-white p-3 shadow-sm">
          {address ? (
            <QRCodeSVG value={address} size={QR_SIZE} aria-label={t("common", T.admin.qrLabel)} />
          ) : (
            <div className="grid place-items-center text-center text-xs text-text-secondary" style={{ width: QR_SIZE, height: QR_SIZE }}>
              {t("common", T.admin.qrEmpty)}
            </div>
          )}
        </div>
        {fields.network && <Badge tone="warning">{fields.network}</Badge>}
      </figure>
    </div>
  );
}

export const CRYPTO_WALLET: TransferKind = {
  kind: "crypto_wallet",
  icon: Wallet,
  destinationFields: [{ id: "asset" }, { id: "network" }, { id: "address" }, { id: "memo", optional: true }, { id: "decimals" }],
  proofFields: ["txHash", "receiptImage", "paidAt"],
  refProofField: "txHash",
  defaultProof: ["txHash"],
  check,
  summary: (f) => `${String(f.asset ?? "")} · ${String(f.network ?? "")} · ${ends(String(f.address ?? ""))}`,
  AdminFields: WalletAdminFields,
};
