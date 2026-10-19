"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { EXPENSE_CATEGORIES, EXPENSE_MAX_MONTHS, EXPENSE_NOTE_MAX, type Expense, expensesApi } from "@/lib/billing/analytics-expenses";
import { currencyApi } from "@/lib/currency-api";
import { Button, Card, CardHeader, Field, Input, Select, notify } from "../../_components/kit";
import { DatePicker } from "../../_components/kit/DatePicker";
import { useExpenseError } from "../_hooks/useRefusalError";
import { type ExpenseForm as Form, expenseBodyOf } from "../_lib/expenses";

const E = FrontendI18nKeys.common.analytics.expenses;

export interface ExpenseFormProps {
  tenantId: string;
  /** The tenant's currency, as billing answered it: a new expense's default. */
  currencyCode: string;
  /** The reader's day: the default day paid, and the latest one allowed. */
  today: string;
  onAdded: (expense: Expense) => void;
}

/**
 * A new general expense (F-1001-u): what it was for, how much in which
 * registered currency, the day it was paid and the months it is spread over —
 * a year's domain is 12. A field billing would refuse says so inline before
 * asking; billing's own refusal is a sentence.
 */
export function ExpenseForm({ tenantId, currencyCode, today, onAdded }: ExpenseFormProps) {
  const { t } = useLocale();
  const errorText = useExpenseError();
  const blank: Form = { category: "equipment", amount: "", currencyCode, spentOn: today, months: "1", note: "" };
  const [form, setForm] = useState<Form>(blank);
  const [codes, setCodes] = useState<string[]>([currencyCode]);
  const [saving, setSaving] = useState(false);
  // Billing's refusal of this form stays beside it, never a toast (kit K10).
  const [refusal, setRefusal] = useState<string | null>(null);
  const checked = expenseBodyOf(form, today);
  // An empty amount is not yet a mistake: the field says so only once something is typed.
  const fieldError = (field: "amount" | "months" | "spentOn") => ("error" in checked && checked.error === field && (field !== "amount" || form.amount !== "") ? t("common", E.form.errors[field], { max: EXPENSE_MAX_MONTHS }) : undefined);

  useEffect(() => {
    let live = true;
    currencyApi
      .rates()
      .then((rates) => live && setCodes([...new Set([currencyCode, ...rates.map((r) => r.code)])]))
      // No list is the tenant's own currency alone, never a failed form.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [currencyCode]);

  const add = async () => {
    if (!("body" in checked)) return;
    setSaving(true);
    setRefusal(null);
    try {
      onAdded(await expensesApi.add(tenantId, checked.body));
      notify.success(t("common", E.form.added));
      setForm(blank);
    } catch (e) {
      setRefusal(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="sm">
      <CardHeader title={t("common", E.form.title)} subtitle={t("common", E.form.subtitle)} className="mb-3" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t("common", E.form.category)}>
          <Select
            value={form.category}
            onChange={(v) => setForm({ ...form, category: EXPENSE_CATEGORIES.find((c) => c === v) ?? form.category })}
            options={EXPENSE_CATEGORIES.map((c) => ({ value: c, label: t("common", E.categories[c]) }))}
          />
        </Field>
        <Field label={t("common", E.form.amount)} error={fieldError("amount")}>
          <Input inputMode="decimal" dir="ltr" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </Field>
        <Field label={t("common", E.form.currency)}>
          <Select value={form.currencyCode} onChange={(v) => setForm({ ...form, currencyCode: v })} options={codes.map((c) => ({ value: c, label: c }))} />
        </Field>
        <div className="flex flex-col gap-1">
          <DatePicker label={t("common", E.form.spentOn)} value={form.spentOn} onChange={(spentOn) => setForm({ ...form, spentOn })} />
          {fieldError("spentOn") && <p className="text-xs text-error">{fieldError("spentOn")}</p>}
        </div>
        <Field label={t("common", E.form.months)} hint={t("common", E.form.monthsHint, { max: EXPENSE_MAX_MONTHS })} error={fieldError("months")}>
          <Input inputMode="numeric" dir="ltr" value={form.months} onChange={(e) => setForm({ ...form, months: e.target.value })} />
        </Field>
        <Field label={t("common", E.form.note)} optional>
          <Input maxLength={EXPENSE_NOTE_MAX} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
      {refusal && (
        <p role="alert" className="mt-2 text-xs text-error">
          {refusal}
        </p>
      )}
      <div className="mt-3">
        <Button size="sm" onClick={add} disabled={!("body" in checked) || saving}>
          {t("common", E.form.add)}
        </Button>
      </div>
    </Card>
  );
}
