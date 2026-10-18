"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Gift, ShieldCheck, Ticket, Users, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { lotteryAdminApi, type LotteryEligibility } from "@/lib/engagement-api";
import type { AudienceGroups } from "../../../_hooks/useAudienceGroups";
import { formatInstant } from "../../../_lib/datetime";
import { ReviewRows, type ReviewRow } from "../../../_components/kit";
import { LOTTERY_ADMIN_KEYS as K, wallClockToInstant, type LotteryForm } from "../_lib/lottery-admin";
import type { LotteryFieldStep } from "../_lib/lottery-steps";
import { useLotteryMessage } from "./lottery-admin-ui";

const W = K.wizard;
const ICONS: Record<LotteryFieldStep, LucideIcon> = { basics: Ticket, schedule: CalendarClock, rules: ShieldCheck, prizes: Gift };

/**
 * The wizard's last step (UX-3-d, K5): each step's choices with a way back to
 * it, then who enters. A saved draft has billing's count (F-707-o), of the
 * draft as saved; a new one has only its group's size until it is saved.
 */
export function LotteryReview({ form, savedId, zone, groups, onEdit }: {
  form: LotteryForm;
  /** The draft's id once saved: its eligible count is billing's. */
  savedId: string | null;
  zone: string | null;
  groups: AudienceGroups;
  onEdit: (step: LotteryFieldStep) => void;
}) {
  const { lang, t } = useLocale();
  const yes = (on: boolean) => t("common", on ? W.review.yes : W.review.no);
  const group = Array.isArray(groups) ? groups.find((g) => g.id === form.userGroupId) : undefined;
  const closes = wallClockToInstant(form.closesAt, zone);
  const winners = form.prizes.reduce((n, p) => n + (Number(p.winnersCount) || 0), 0);

  const rows: Record<LotteryFieldStep, ReviewRow[]> = {
    basics: [
      [t("common", K.fields.title), <span key="title" dir="auto">{form.title.trim()}</span>],
      [t("common", K.fields.group), group?.name ?? form.userGroupId],
      ...(form.description.trim() ? [[t("common", K.fields.description), <span key="description" dir="auto">{form.description.trim()}</span>] as ReviewRow] : []),
    ],
    schedule: [
      [t("common", K.fields.closesAt), (closes && formatInstant(closes, lang)) ?? form.closesAt],
      [t("common", K.fields.entryMode), t("common", K.mode[form.entryMode])],
    ],
    rules: [
      [t("common", K.fields.phoneVerified), yes(form.requiresPhoneVerified)],
      [t("common", K.fields.minAgeHours), form.requiresMinAccountAgeHours],
      [t("common", K.fields.reservesCount), form.reservesCount],
    ],
    prizes: form.prizes.map((p, i) => [`${i + 1}. ${p.label.trim()}`, p.winnersCount]),
  };

  return (
    <div className="flex flex-col gap-3">
      {(Object.keys(rows) as LotteryFieldStep[]).map((step) => (
        <section key={step} className="rounded-2xl border border-card-border p-4">
          <ReviewRows icon={ICONS[step]} title={t("common", W.steps[step].title)} editLabel={t("common", W.edit)} onEdit={() => onEdit(step)} rows={rows[step]} />
        </section>
      ))}
      <section className="space-y-1 rounded-2xl bg-bg-inner p-4 text-xs">
        <p className="flex items-center gap-2 font-bold text-text-primary">
          <Users size={14} className="text-primary" aria-hidden />
          {t("common", W.review.eligibleTitle)}
        </p>
        <p className="text-text-secondary">{t("common", W.review.prizes, { n: form.prizes.length, winners })}</p>
        {group && <p className="text-text-secondary">{t("common", W.review.groupMembers, { n: group.userCount })}</p>}
        {savedId ? <SavedCount id={savedId} /> : <p className="text-text-secondary">{t("common", W.review.afterSave)}</p>}
      </section>
    </div>
  );
}

/** Billing's estimate for the saved draft: who would get a ticket if it closed now. */
function SavedCount({ id }: { id: string }) {
  const { t } = useLocale();
  const message = useLotteryMessage();
  const [read, setRead] = useState<{ data: LotteryEligibility } | { error: unknown } | null>(null);
  useEffect(() => {
    let alive = true;
    lotteryAdminApi.eligibility(id).then(
      (data) => alive && setRead({ data }),
      (error: unknown) => alive && setRead({ error }),
    );
    return () => {
      alive = false;
    };
  }, [id]);

  if (!read) return <p className="text-text-secondary">{t("common", K.eligibility.loading)}</p>;
  if ("error" in read) return <p className="text-error">{message(read.error)}</p>;
  return (
    <>
      <p className="font-bold text-text-primary">{t("common", K.eligibility.wouldGet, { n: read.data.eligible })}</p>
      <p className="text-text-secondary">{t("common", W.review.savedNote)}</p>
    </>
  );
}
