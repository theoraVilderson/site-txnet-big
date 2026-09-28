"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { Me, UserSearchHit } from "@/lib/auth-api";
import { billingApi, type DiscountRule } from "@/lib/billing-api";
import { DatePicker } from "../../_components/kit/DatePicker";
import { Alert, Field, Sheet, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";
import { Toggle } from "../../gateways/_components/gateway-fields";
import { UserSearch } from "../../user-groups/_components/UserSearch";
import { memberSearchOf } from "../../user-groups/_lib/user-groups";
import {
  RULE_KEYS as K,
  createRuleBody,
  emptyRuleForm,
  formFromRule,
  idsOf,
  ruleRefusalKey,
  updateRuleBody,
  validateRuleForm,
  type RuleAudience,
  type RuleForm,
  type RuleFormErrors,
  type RuleTarget,
} from "../_lib/discount-rules";
import { ChoicePicker, type Choices } from "./ChoicePicker";

const F = K.form;

export interface RuleChoices {
  products: Choices;
  categories: Choices;
  groups: Choices;
}

/**
 * Create or edit a discount with no code (F-114-k). The rules are
 * `discount-rules.ts`'s, which mirror billing's; an edit sends only what
 * changed, the target and the audience each as a unit.
 */
export function DiscountRuleForm({ me, rule, choices, onClose, onSaved }: { me: Me | null; rule: DiscountRule | null; choices: RuleChoices; onClose: () => void; onSaved: (notice: string) => void | Promise<void> }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const [form, setForm] = useState<RuleForm>(() => (rule ? formFromRule(rule) : emptyRuleForm()));
  const [errors, setErrors] = useState<RuleFormErrors>({});
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const search = memberSearchOf(me);

  const set = <Key extends keyof RuleForm>(k: Key, v: RuleForm[Key]) => {
    setTouched(true);
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const requestClose = () => {
    if (touched && !window.confirm(t("common", F.confirmClose))) return;
    onClose();
  };

  const addUser = (hit: UserSearchHit) => set("userIds", idsOf(`${form.userIds}\n${hit.id}`).join("\n"));

  const submit = async () => {
    const found = validateRuleForm(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setFailure(null);
    try {
      if (rule) {
        const body = updateRuleBody(form, rule);
        if (Object.keys(body).length > 0) await billingApi.updateDiscountRule(rule.id, body);
        await onSaved(t("common", K.saved));
      } else {
        const created = await billingApi.createDiscountRule(createRuleBody(form));
        await onSaved(t("common", K.created, { name: created.name }));
      }
    } catch (e) {
      const key = ruleRefusalKey(e);
      setFailure(key ? t("common", key) : errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const radios = <V extends string>(name: string, value: V, options: readonly (readonly [V, string])[], onPick: (v: V) => void) => (
    <div role="radiogroup" className="flex flex-wrap gap-2">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          name={name}
          onClick={() => onPick(v)}
          className={`rounded-xl border px-3 py-2 text-xs font-bold transition-colors ${value === v ? "border-primary bg-primary/10 text-primary" : "border-card-border text-text-secondary hover:text-text-primary"}`}
        >
          {t("common", label)}
        </button>
      ))}
    </div>
  );

  const footer = (
    <div className="flex items-center justify-end gap-2">
      <button type="button" className={quietButton} onClick={requestClose}>
        {t("common", F.cancel)}
      </button>
      <button type="button" className={primaryButton} disabled={saving} onClick={() => void submit()}>
        {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
        {t("common", saving ? F.saving : F.save)}
      </button>
    </div>
  );

  return (
    <Sheet title={rule ? t("common", F.titleEdit, { name: rule.name }) : t("common", F.titleNew)} onClose={requestClose} footer={footer}>
      {rule && <p className="text-xs text-text-secondary">{t("common", F.editNote)}</p>}
      {failure && <Alert>{failure}</Alert>}

      <Field label={t("common", F.name)} error={errors.name} hint={t("common", F.nameHint)}>
        <input className={input} value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1 text-xs font-bold text-text-secondary">
          {t("common", F.kind)}
          {radios(
            "kind",
            form.kind,
            [
              ["percentage", F.percentage],
              ["fixed_amount", F.fixedAmount],
            ],
            (v) => set("kind", v),
          )}
        </div>
        <Field
          label={t("common", F.value)}
          error={errors.value}
          hint={
            form.kind === "percentage"
              ? t("common", F.valueHintPercent)
              : // An edit is in the rule's own currency; a new rule takes the tenant's, which this form is not told (F-116-h3).
                rule
                ? t("common", F.valueHintAmount, { currency: rule.currencyCode })
                : t("common", F.valueHintAmountUnknown)
          }
        >
          <input className={input} dir="ltr" inputMode="decimal" value={form.value} onChange={(e) => set("value", e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-col gap-2 text-xs font-bold text-text-secondary">
        {t("common", F.target)}
        {radios<RuleTarget>(
          "target",
          form.target,
          [
            ["all", F.targetAll],
            ["product", F.targetProduct],
            ["category", F.targetCategory],
          ],
          (v) => set("target", v),
        )}
      </div>
      {form.target === "product" && (
        <Field label={t("common", F.product)} error={errors.productId}>
          <ChoicePicker id="rule-product" value={form.productId} onChange={(v) => set("productId", v)} choices={choices.products} invalid={!!errors.productId} />
        </Field>
      )}
      {form.target === "category" && (
        <Field label={t("common", F.category)} error={errors.categoryId} hint={t("common", F.categoryHint)}>
          <ChoicePicker id="rule-category" value={form.categoryId} onChange={(v) => set("categoryId", v)} choices={choices.categories} invalid={!!errors.categoryId} />
        </Field>
      )}

      <div className="flex flex-col gap-2 text-xs font-bold text-text-secondary">
        {t("common", F.audience)}
        {radios<RuleAudience>(
          "audience",
          form.audience,
          [
            ["everyone", F.audienceEveryone],
            ["named", F.audienceNamed],
            ["group", F.audienceGroup],
          ],
          (v) => set("audience", v),
        )}
      </div>
      {form.audience === "named" && (
        <>
          {search !== "ids" && <UserSearch via={search} tenantId={me?.tenant?.id ?? ""} onAdd={addUser} busy={saving} />}
          <Field label={t("common", F.userIds)} error={errors.userIds} hint={t("common", F.userIdsHint)}>
            <textarea className={`${input} min-h-24 font-mono text-xs`} dir="ltr" value={form.userIds} onChange={(e) => set("userIds", e.target.value)} />
          </Field>
        </>
      )}
      {form.audience === "group" && (
        <Field label={t("common", F.group)} error={errors.groupId} hint={t("common", F.groupHint)}>
          <ChoicePicker id="rule-group" value={form.groupId} onChange={(v) => set("groupId", v)} choices={choices.groups} invalid={!!errors.groupId} />
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("common", F.startsAt)} error={errors.startsAt}>
          <DatePicker value={form.startsAt || null} onChange={(v) => set("startsAt", v ?? "")} />
        </Field>
        <Field label={t("common", F.endsAt)} error={errors.endsAt} hint={t("common", F.endsAtHint)}>
          <DatePicker value={form.endsAt || null} onChange={(v) => set("endsAt", v ?? "")} />
        </Field>
      </div>

      <Toggle checked={form.isActive} onChange={(v) => set("isActive", v)} label={t("common", F.active)} />
    </Sheet>
  );
}
