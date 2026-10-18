"use client";

import { CalendarClock, Gift, Users, Wallet, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { AudienceGroups } from "../../../_hooks/useAudienceGroups";
import { ReviewRows, type ReviewRow } from "../../../_components/kit";
import { formatDay, plainNumber } from "../../_lib/wheel";
import { WHEEL_SETTINGS_KEYS as K, capLastsSpins, expectedCostPerSpin, oddsPercents, type WheelForm } from "../_lib/wheel-settings";
import type { WheelFieldStep } from "../_lib/wheel-steps";
import { dayAfter } from "./wheel-settings-ui";

const W = K.wizard;
const ICONS: Record<WheelFieldStep, LucideIcon> = { basics: Wallet, eligibility: Users, prizes: Gift };

/**
 * The wizard's last step (UX-3-c, K5): each step's choices with a way back to
 * it, then what the wheel costs — the average per spin and how many spins the
 * cap pays for, counted as billing counts them — and the day it starts.
 */
export function WheelReview({ form, today, currency, decimals, money, groups, onEdit }: {
  form: WheelForm;
  today: string;
  currency: string;
  decimals: number;
  /** An amount in the wheel's currency, as the page formats money. */
  money: (amount: string) => string;
  groups: AudienceGroups;
  onEdit: (step: WheelFieldStep) => void;
}) {
  const { lang, t } = useLocale();
  const expected = expectedCostPerSpin(form.prizes, decimals);
  const lasts = expected && capLastsSpins(form.cap, expected, decimals);
  const odds = oddsPercents(form.prizes.map((p) => p.weight));
  const yes = (on: boolean) => t("common", on ? W.review.yes : W.review.no);
  const orNone = (v: string, show: (v: string) => string = (x) => x) => (v.trim() ? show(v.trim()) : t("common", W.review.none));
  const group = Array.isArray(groups) ? groups.find((g) => g.id === form.userGroupId)?.name : undefined;

  const rows: Record<WheelFieldStep, ReviewRow[]> = {
    basics: [
      [t("common", K.versions.cap), money(form.cap)],
      [t("common", W.review.state), t("common", form.isActive ? W.review.on : W.review.off)],
    ],
    eligibility: [
      [t("common", K.fields.maxSpins), form.maxSpins],
      [t("common", K.fields.cooldownHours), form.cooldownHours],
      [t("common", K.fields.minAgeHours), form.minAgeHours],
      [t("common", K.fields.minPaid, { currency }), orNone(form.minPaid, money)],
      [t("common", K.fields.minOrders), orNone(form.minOrders)],
      [t("common", K.fields.userGroup), form.userGroupId ? (group ?? form.userGroupId) : t("common", W.review.everyone)],
      [t("common", K.fields.activeService), yes(form.activeService)],
      [t("common", K.fields.phoneVerified), yes(form.phoneVerified)],
    ],
    prizes: form.prizes.map((p, i) => [
      `${i + 1}. ${p.label.trim()}`,
      `${odds ? `${plainNumber(odds[i])}%` : "—"} · ${money(p.costAmount)}`,
    ]),
  };

  return (
    <div className="flex flex-col gap-3">
      {(Object.keys(rows) as WheelFieldStep[]).map((step) => (
        <section key={step} className="rounded-2xl border border-card-border p-4">
          <ReviewRows icon={ICONS[step]} title={t("common", W.steps[step].title)} editLabel={t("common", W.edit)} onEdit={() => onEdit(step)} rows={rows[step]} />
        </section>
      ))}
      <section className="space-y-1 rounded-2xl bg-bg-inner p-4 text-xs">
        {expected === null ? (
          <p className="text-text-secondary">{t("common", K.cost.unknown)}</p>
        ) : (
          <>
            <p className="font-bold text-text-primary">{t("common", K.cost.expected, { amount: money(expected) })}</p>
            <p className="text-text-secondary">{lasts === null ? t("common", K.cost.free) : t("common", K.cost.capLasts, { n: lasts })}</p>
          </>
        )}
        <p className="flex items-center gap-2 pt-2 text-text-secondary">
          <CalendarClock size={14} className="shrink-0 text-primary" aria-hidden />
          <span>{t("common", K.startsTomorrow, { day: formatDay(dayAfter(today), lang) })}</span>
        </p>
      </section>
    </div>
  );
}
