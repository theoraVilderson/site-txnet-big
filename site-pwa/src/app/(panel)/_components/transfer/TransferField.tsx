"use client";

import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Field, Input } from "../kit";
import type { AdminFieldsProps } from "./transfer-kind";

const T = FrontendI18nKeys.common.transfer;

type FieldId = keyof typeof T.fields;

interface TransferFieldProps extends Pick<AdminFieldsProps, "fields" | "onChange" | "errors"> {
  id: FieldId;
  /** A card number, an address or a hash: Latin and `ltr` always, so copy and paste match the bank's form (principle 4). */
  ltr?: boolean;
  numeric?: boolean;
  optional?: boolean;
  placeholder?: string;
  /** Applied to the typed text before it is held — digits folded, an asset upper-cased. */
  fold?: (raw: string) => string;
}

/** One destination field: its label, hint and refusal from `transfer.*`, the kit's input. */
export function TransferField({ id, fields, onChange, errors, ltr, numeric, optional, placeholder, fold }: TransferFieldProps) {
  const { t } = useLocale();
  const refusal = errors[id];
  return (
    <Field
      label={t("common", T.fields[id])}
      optional={optional}
      hint={id in T.hints ? t("common", T.hints[id as keyof typeof T.hints]) : undefined}
      error={refusal ? t("common", T.refusal[refusal]) : undefined}
    >
      <Input
        dir={ltr ? "ltr" : undefined}
        inputMode={numeric ? "numeric" : undefined}
        placeholder={placeholder}
        value={fields[id] ?? ""}
        onChange={(e) => onChange(id, fold ? fold(e.target.value) : e.target.value)}
      />
    </Field>
  );
}
