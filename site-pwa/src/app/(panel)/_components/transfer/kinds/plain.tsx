"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Field, Input } from "../../kit";
import { CopyButton } from "../CopyButton";
import type { AdminFieldsProps, DestinationProps } from "../transfer-kind";

const T = FrontendI18nKeys.common.transfer;
const P = FrontendI18nKeys.common.transferPay.card;

/**
 * A kind the panel has no drawing for yet (principle 1's fallback): the
 * destination's stored fields as plain text boxes, named as billing names
 * them. It edits what is there and adds nothing; billing's kind checks it.
 */
export function PlainAdminFields({ fields, onChange }: AdminFieldsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Object.keys(fields).map((id) => (
        <Field key={id} label={<span dir="ltr">{id}</span>}>
          <Input dir="ltr" value={fields[id]} onChange={(e) => onChange(id, e.target.value)} />
        </Field>
      ))}
    </div>
  );
}

/**
 * The payer's side of the same fallback (F-803-i): every public field of the
 * destination, labelled when the panel knows the id, each copyable and `ltr`
 * (principle 4) — so a payment on a kind newer than the panel is still payable.
 */
export function PlainDestination({ destination }: DestinationProps) {
  const { t } = useLocale();
  return (
    <dl className="flex flex-col divide-y divide-card-border rounded-2xl border border-card-border">
      {Object.entries(destination).map(([id, value]) => {
        const label = id in T.fields ? t("common", T.fields[id as keyof typeof T.fields]) : id;
        return (
          <div key={id} className="flex items-center justify-between gap-3 p-3">
            <div className="min-w-0">
              <dt className="text-xs text-text-secondary">{label}</dt>
              <dd dir="ltr" className="break-all font-mono text-sm font-bold text-text-primary">
                {String(value)}
              </dd>
            </div>
            <CopyButton value={String(value)} label={`${t("common", P.copy)} ${label}`} copiedLabel={t("common", P.copied)} iconOnly />
          </div>
        );
      })}
    </dl>
  );
}
