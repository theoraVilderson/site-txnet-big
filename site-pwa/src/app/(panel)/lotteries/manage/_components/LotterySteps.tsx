"use client";

import { useLocale } from "@/context/LocaleContext";
import type { AdminCoupon } from "@/lib/billing-api";
import type { PrizeSource } from "../../../_hooks/usePrizeSources";
import type { AudienceGroups } from "../../../_hooks/useAudienceGroups";
import type { PrizeFormCheck } from "../../../_components/prizes/prize-steps";
import { PrizeListStep } from "../../../_components/prizes/PrizeListStep";
import { AudiencePicker } from "../../../_components/AudiencePicker";
import { Field } from "../../../catalog/_components/catalog-ui";
import { Button, Checkbox, Input, Textarea } from "../../../_components/kit";
import { Select } from "../../../_components/kit/Select";
import { LOTTERY_ADMIN_KEYS as K, LOTTERY_PRIZE_TYPES, PRIZES_MAX, PRIZE_TYPE_KEYS, emptyLotteryPrize, type LotteryForm, type LotteryPrizeForm } from "../_lib/lottery-admin";
import { CLOSE_SHORTCUTS, closeAfterDays, type CloseShortcut, type LotteryFieldStep } from "../_lib/lottery-steps";

const W = K.wizard;

export interface LotteryStepProps {
  step: LotteryFieldStep;
  form: LotteryForm;
  set: <F extends keyof LotteryForm>(field: F, value: LotteryForm[F]) => void;
  shown: PrizeFormCheck<string, keyof LotteryPrizeForm & string>;
  /** The admin's resolved zone (TZ-1-e): the close is typed and shortcut on its wall clock. */
  zone: string | null;
  templates: PrizeSource<AdminCoupon>;
  groups: AudienceGroups;
  ownerTenant: string | null;
}

/** One step of the draft wizard (UX-3-d); the review is `LotteryReview`. */
export function LotteryStepFields(props: LotteryStepProps) {
  switch (props.step) {
    case "basics":
      return <BasicsStep {...props} />;
    case "schedule":
      return <ScheduleStep {...props} />;
    case "rules":
      return <RulesStep {...props} />;
    case "prizes":
      return <PrizesStep {...props} />;
  }
}

function BasicsStep({ form, set, shown, groups }: LotteryStepProps) {
  const { t } = useLocale();
  return (
    <>
      <Field label={t("common", K.fields.title)} error={shown.fields.title}>
        <Input dir="auto" value={form.title} onChange={(e) => set("title", e.target.value)} />
      </Field>
      {/* A lottery is always for one group: no "every user" (ADR-0143). */}
      <Field label={t("common", K.fields.group)} error={shown.fields.userGroupId}>
        <AudiencePicker everyone={false} groups={groups} value={form.userGroupId ? [form.userGroupId] : []} onChange={(ids) => set("userGroupId", ids[0] ?? "")} />
      </Field>
      <Field label={t("common", K.fields.description)} error={shown.fields.description} hint={t("common", K.fields.optional)}>
        <Textarea className="min-h-20" dir="auto" value={form.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
    </>
  );
}

function ScheduleStep({ form, set, shown, zone }: LotteryStepProps) {
  const { t } = useLocale();
  return (
    <>
      <Field label={t("common", K.fields.closesAt)} error={shown.fields.closesAt} hint={t("common", K.fields.closesAtHint, { zone: zone ?? "—" })}>
        <Input dir="ltr" type="datetime-local" value={form.closesAt} onChange={(e) => set("closesAt", e.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-secondary">{t("common", W.shortcutsLabel)}</span>
        {(Object.keys(CLOSE_SHORTCUTS) as CloseShortcut[]).map((s) => (
          <Button key={s} variant="quiet" size="sm" onClick={() => set("closesAt", closeAfterDays(CLOSE_SHORTCUTS[s], new Date(), zone))}>
            {t("common", W.shortcuts[s])}
          </Button>
        ))}
      </div>
      <Field label={t("common", K.fields.entryMode)}>
        <Select
          value={form.entryMode}
          onChange={(v) => set("entryMode", v as LotteryForm["entryMode"])}
          options={(["automatic", "opt_in"] as const).map((m) => ({ value: m, label: t("common", K.mode[m]) }))}
        />
      </Field>
    </>
  );
}

function RulesStep({ form, set, shown }: LotteryStepProps) {
  const { t } = useLocale();
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label={t("common", K.fields.minAgeHours)} error={shown.fields.requiresMinAccountAgeHours}>
          <Input dir="ltr" inputMode="numeric" value={form.requiresMinAccountAgeHours} onChange={(e) => set("requiresMinAccountAgeHours", e.target.value)} />
        </Field>
        <Field label={t("common", K.fields.reservesCount)} error={shown.fields.reservesCount} hint={t("common", K.fields.reservesHint)}>
          <Input dir="ltr" inputMode="numeric" value={form.reservesCount} onChange={(e) => set("reservesCount", e.target.value)} />
        </Field>
      </div>
      <Checkbox checked={form.requiresPhoneVerified} onChange={(on) => set("requiresPhoneVerified", on)} label={t("common", K.fields.phoneVerified)} />
    </>
  );
}

function PrizesStep({ form, set, shown, templates, ownerTenant }: LotteryStepProps) {
  const { t } = useLocale();
  return (
    <PrizeListStep
      prizes={form.prizes}
      errors={shown.prizes}
      overall={shown.overall}
      keys={K.prizes}
      types={LOTTERY_PRIZE_TYPES}
      typeKeys={PRIZE_TYPE_KEYS}
      templates={templates}
      ownerTenant={ownerTenant}
      idPrefix="lottery"
      max={PRIZES_MAX}
      newPrize={emptyLotteryPrize}
      onChange={(prizes) => set("prizes", prizes)}
      rowTitle={(i) => t("common", K.prizes.rank, { n: i + 1 })}
      extra={(p, _i, e, patch) => (
        <Field label={t("common", K.prizes.winnersCount)} error={e.winnersCount}>
          <Input dir="ltr" inputMode="numeric" value={p.winnersCount} onChange={(ev) => patch({ winnersCount: ev.target.value })} />
        </Field>
      )}
    />
  );
}
