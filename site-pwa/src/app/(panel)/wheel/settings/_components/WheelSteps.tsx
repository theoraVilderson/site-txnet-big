"use client";

import { Sparkles } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { AdminCoupon } from "@/lib/billing-api";
import type { PrizeSource } from "../../../_hooks/usePrizeSources";
import type { AudienceGroups } from "../../../_hooks/useAudienceGroups";
import type { PrizeFormCheck } from "../../../_components/prizes/prize-steps";
import { PrizeListStep } from "../../../_components/prizes/PrizeListStep";
import { useRowKeys } from "../../../_hooks/useRowKeys";
import { AudiencePicker } from "../../../_components/AudiencePicker";
import { Button, Checkbox, Input } from "../../../_components/kit";
import { WheelDisc } from "../../_components/WheelDisc";
import { plainNumber } from "../../_lib/wheel";
import { PRIZES_MAX, PRIZE_TYPES, PRIZE_TYPE_KEYS, WHEEL_SETTINGS_KEYS as K, emptyPrize, oddsPercents, type PrizeForm, type WheelForm } from "../_lib/wheel-settings";
import { slotsUntouched, starterPrizes, type WheelFieldStep } from "../_lib/wheel-steps";
import { Field } from "./wheel-settings-ui";

const W = K.wizard;

export interface WheelStepProps {
  step: WheelFieldStep;
  form: WheelForm;
  set: <F extends keyof WheelForm>(field: F, value: WheelForm[F]) => void;
  shown: PrizeFormCheck<string, keyof PrizeForm & string>;
  currency: string;
  /** A first wheel: the starter set is offered while no slot was touched. */
  isFirst: boolean;
  templates: PrizeSource<AdminCoupon>;
  groups: AudienceGroups;
  ownerTenant: string | null;
}

/** One step of the new-version wizard (UX-3-c); the review is `WheelReview`. */
export function WheelStepFields(props: WheelStepProps) {
  if (props.step === "basics") return <BasicsStep {...props} />;
  if (props.step === "eligibility") return <EligibilityStep {...props} />;
  return <PrizesStep {...props} />;
}

function BasicsStep({ form, set, shown, currency }: WheelStepProps) {
  const { t } = useLocale();
  return (
    <>
      <Field label={t("common", K.fields.cap, { currency })} error={shown.fields.cap} hint={t("common", K.fields.capHint)}>
        <Input dir="ltr" inputMode="decimal" value={form.cap} onChange={(e) => set("cap", e.target.value)} />
      </Field>
      <Checkbox checked={form.isActive} onChange={(on) => set("isActive", on)} label={t("common", K.fields.isActive)} />
    </>
  );
}

function EligibilityStep({ form, set, shown, currency, groups }: WheelStepProps) {
  const { t } = useLocale();
  const num = (field: "maxSpins" | "cooldownHours" | "minAgeHours" | "minOrders", label: string, hint?: string) => (
    <Field label={label} error={shown.fields[field]} hint={hint}>
      <Input dir="ltr" inputMode="numeric" value={form[field]} onChange={(e) => set(field, e.target.value)} />
    </Field>
  );
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        {num("maxSpins", t("common", K.fields.maxSpins))}
        {num("cooldownHours", t("common", K.fields.cooldownHours))}
        {num("minAgeHours", t("common", K.fields.minAgeHours))}
        <Field label={t("common", K.fields.minPaid, { currency })} error={shown.fields.minPaid} hint={t("common", K.fields.optional)}>
          <Input dir="ltr" inputMode="decimal" value={form.minPaid} onChange={(e) => set("minPaid", e.target.value)} />
        </Field>
        {num("minOrders", t("common", K.fields.minOrders), t("common", K.fields.optional))}
      </div>
      <Field label={t("common", K.fields.userGroup)} error={shown.fields.userGroupId}>
        <AudiencePicker groups={groups} value={form.userGroupId ? [form.userGroupId] : []} onChange={(ids) => set("userGroupId", ids[0] ?? "")} />
      </Field>
      <div className="flex flex-wrap gap-4">
        <Checkbox checked={form.activeService} onChange={(on) => set("activeService", on)} label={t("common", K.fields.activeService)} />
        <Checkbox checked={form.phoneVerified} onChange={(on) => set("phoneVerified", on)} label={t("common", K.fields.phoneVerified)} />
      </div>
    </>
  );
}

function PrizesStep({ form, set, shown, currency, isFirst, templates, ownerTenant }: WheelStepProps) {
  const { t } = useLocale();
  const odds = oddsPercents(form.prizes.map((p) => p.weight));
  const fillStarter = () =>
    set(
      "prizes",
      starterPrizes({
        tryAgain: t("common", W.starter.tryAgain),
        gb: (n) => t("common", W.starter.gb, { n }),
        days: (n) => t("common", W.starter.days, { n }),
      }),
    );

  return (
    <>
      {isFirst && slotsUntouched(form.prizes) && (
        <aside className="flex flex-col gap-2 rounded-2xl border border-dashed border-card-border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold text-text-primary">{t("common", W.starter.title)}</p>
            <p className="text-xs text-text-secondary">{t("common", W.starter.hint)}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={fillStarter} icon={<Sparkles size={12} aria-hidden />}>
            {t("common", W.starter.use)}
          </Button>
        </aside>
      )}
      <WheelPreview prizes={form.prizes} odds={odds} />
      <PrizeListStep
        prizes={form.prizes}
        errors={shown.prizes}
        overall={shown.overall}
        keys={K.prizes}
        types={PRIZE_TYPES}
        typeKeys={PRIZE_TYPE_KEYS}
        templates={templates}
        ownerTenant={ownerTenant}
        idPrefix="wheel"
        max={PRIZES_MAX}
        newPrize={emptyPrize}
        onChange={(prizes) => set("prizes", prizes)}
        rowTitle={(i) => (
          <>
            <span>{t("common", K.prizes.slot, { n: i + 1 })}</span>
            {odds && <span className="ms-2 font-normal text-text-secondary">{t("common", K.prizes.odds)}: {plainNumber(odds[i])}%</span>}
          </>
        )}
        // An empty slot costs nothing.
        adjust={(change) => ({ ...change, ...(change.prizeType === "empty" ? { costAmount: "0" } : {}) })}
        extra={(p, _i, e, patch) => (
          <>
            <Field label={t("common", K.prizes.weight)} error={e.weight}>
              <Input dir="ltr" inputMode="numeric" value={p.weight} onChange={(ev) => patch({ weight: ev.target.value })} />
            </Field>
            {p.prizeType !== "empty" && (
              <>
                <Field label={t("common", K.prizes.cost, { currency })} error={e.costAmount}>
                  <Input dir="ltr" inputMode="decimal" value={p.costAmount} onChange={(ev) => patch({ costAmount: ev.target.value })} />
                </Field>
                <Field label={t("common", K.prizes.stock)} error={e.dailyStockLimit} hint={t("common", K.prizes.stockHint)}>
                  <Input dir="ltr" inputMode="numeric" value={p.dailyStockLimit} onChange={(ev) => patch({ dailyStockLimit: ev.target.value })} />
                </Field>
              </>
            )}
          </>
        )}
      />
    </>
  );
}

/** The disc as users will see it, slot 1 at the pointer, with each slot's chance beside it. */
function WheelPreview({ prizes, odds }: { prizes: readonly PrizeForm[]; odds: string[] | null }) {
  const { t } = useLocale();
  const rowKeys = useRowKeys(prizes);
  const names = prizes.map((p, i) => p.label.trim() || t("common", K.prizes.slot, { n: i + 1 }));
  return (
    <figure role="img" aria-label={t("common", W.preview)} className="flex flex-col items-center gap-4 rounded-2xl bg-bg-inner p-4 sm:flex-row sm:items-start">
      <div className="w-44 shrink-0">
        <WheelDisc slots={names} rotation={0} durationMs={0} />
      </div>
      <figcaption className="w-full min-w-0 text-xs">
        <p className="mb-2 font-bold text-text-primary">{t("common", W.odds)}</p>
        <ol className="space-y-1">
          {names.map((name, i) => (
            <li key={rowKeys[i]} className="flex justify-between gap-3">
              <span className="truncate text-text-secondary" dir="auto">
                {i + 1}. {name}
              </span>
              <span dir="ltr" className="font-bold text-text-primary">
                {odds ? `${plainNumber(odds[i])}%` : "—"}
              </span>
            </li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}
