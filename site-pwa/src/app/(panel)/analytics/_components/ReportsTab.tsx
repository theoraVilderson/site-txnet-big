"use client";

import { useCallback, useEffect, useState } from "react";
import { Bot, Mail, PauseCircle } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import { useReportError } from "../_hooks/useReportError";
import { useLiveReread } from "@/hooks/useLiveReread";
import type { AnalyticsCalendar, AnalyticsTab } from "@/lib/billing/analytics";
import { REPORT_SCHEDULES_PER_PERSON, type ReportSchedule, type ReportSchedules, reportSchedulesApi } from "@/lib/billing/analytics-reports";
import { userChannel } from "@/lib/realtime";
import { usePanelSession } from "../../_context/PanelSessionContext";
import { Alert, Badge, Button, Card, CardHeader, notify } from "../../_components/kit";
import { formatInstant } from "../../_lib/datetime";
import { hourName, weekdayName } from "../_lib/reports";
import { ReportScheduleForm } from "./ReportScheduleForm";

const R = FrontendI18nKeys.common.analytics.reports;

export interface ReportsTabProps {
  tenantId: string;
  calendar: AnalyticsCalendar;
  tabName: (tab: AnalyticsTab) => string;
}

/**
 * The Reports tab (F-1006-b, panel-web `contract.analytics-tabs.md`
 * "Reports"; billing `contract.analytics-reports.md`): the person's own
 * scheduled reports — or, for the tenant's owner, everyone's — each with
 * when it goes, where, its next and last send; add, pause, send now, remove.
 * Live on the person's own `billing.analytics.report` (C-14): a send moves
 * "last sent" without a poll.
 */
export function ReportsTab({ tenantId, calendar, tabName }: ReportsTabProps) {
  const { t, lang } = useLocale();
  const errorText = useReportError();
  const { me } = usePanelSession();
  const [answer, setAnswer] = useState<ReportSchedules | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    reportSchedulesApi.list(tenantId).then(
      (next) => {
        setAnswer(next);
        setError(null);
      },
      (e: unknown) => setError(e),
    );
  }, [tenantId]);
  useEffect(load, [load]);
  useLiveReread(me ? userChannel(me.userId) : null, [RealtimeEvents.analyticsReport], load);

  /** One action on one schedule, the list read again after it. */
  const act = async (id: string, work: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await work();
      notify.success(t("common", done));
      load();
    } catch (e) {
      notify.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const when = (s: ReportSchedule) => {
    const at = hourName(s.hour, lang);
    if (s.frequency === "weekly") return t("common", R.when.weekly, { day: weekdayName(s.weekday ?? 0, lang), hour: at });
    return t("common", R.when[s.frequency], { hour: at });
  };
  const instant = (iso: string) => formatInstant(iso, lang) ?? iso;

  if (error && !answer) return <Alert tone="error" title={t("common", R.loadFailed)}>{errorText(error)}</Alert>;
  if (!answer) return <p className="text-sm text-text-secondary">{t("common", R.loading)}</p>;
  const mine = answer.schedules.filter((s) => s.mine).length;

  return (
    <div className="flex flex-col gap-4">
      <ReportScheduleForm
        tenantId={tenantId}
        calendar={calendar}
        tabName={tabName}
        reach={answer.reach}
        full={mine >= REPORT_SCHEDULES_PER_PERSON}
        onAdded={load}
      />
      <Card padding="sm">
        <CardHeader title={t("common", R.title)} subtitle={t("common", R.subtitle)} className="mb-2" />
        {answer.schedules.length === 0 ? (
          <p className="p-2 text-sm text-text-secondary">{t("common", R.empty)}</p>
        ) : (
          <ul className="divide-y divide-card-border">
            {answer.schedules.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-semibold text-text-primary">
                    {when(s)}
                    {!s.mine && <span className="font-normal text-text-secondary"> · {t("common", R.for, { name: s.name ?? t("common", R.someone) })}</span>}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                    {t("common", R.opens, { tab: tabName(s.tab) })}
                    {s.bot && <Badge tone="neutral" icon={<Bot size={12} aria-hidden />}>{t("common", R.channels.bot)}</Badge>}
                    {s.email && <Badge tone="neutral" icon={<Mail size={12} aria-hidden />}>{t("common", R.channels.email)}</Badge>}
                    {s.paused && <Badge tone="warning" icon={<PauseCircle size={12} aria-hidden />}>{t("common", R.paused)}</Badge>}
                  </span>
                  <span className="text-xs text-text-secondary">
                    {s.paused ? null : t("common", R.next, { at: instant(s.nextRunAt) })}
                    {s.lastSentAt && ` · ${t("common", R.last, { at: instant(s.lastSentAt) })}`}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {s.mine && (
                    <Button size="sm" variant="secondary" disabled={busy === s.id} onClick={() => act(s.id, () => reportSchedulesApi.sendNow(tenantId, s.id), R.sent)}>
                      {t("common", R.sendNow)}
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" disabled={busy === s.id} onClick={() => act(s.id, () => reportSchedulesApi.change(tenantId, s.id, { paused: !s.paused }), s.paused ? R.resumed : R.pausedDone)}>
                    {t("common", s.paused ? R.resume : R.pause)}
                  </Button>
                  <Button size="sm" variant="quiet" disabled={busy === s.id} onClick={() => act(s.id, () => reportSchedulesApi.remove(tenantId, s.id), R.removed)}>
                    {t("common", R.remove)}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
