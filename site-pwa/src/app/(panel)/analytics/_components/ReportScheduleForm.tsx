"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useReportError } from "../_hooks/useReportError";
import { ANALYTICS_TABS, type AnalyticsCalendar, type AnalyticsTab } from "@/lib/billing/analytics";
import { REPORT_FREQUENCIES, type ReportSchedule, type ReportTab, reportSchedulesApi } from "@/lib/billing/analytics-reports";
import { Button, Card, CardHeader, Checkbox, Field, SegmentedControl, Select, notify } from "../../_components/kit";
import { DEFAULT_REPORT_FORM, REPORT_HOURS, REPORT_WEEKDAYS, hourName, reportBodyOf, weekdayName } from "../_lib/reports";

const R = FrontendI18nKeys.common.analytics.reports;
/** Every tab a report's link may open, in the page's order. */
const REPORT_TABS = ANALYTICS_TABS.filter((tab): tab is ReportTab => tab !== "resellers");

export interface ReportScheduleFormProps {
  tenantId: string;
  calendar: AnalyticsCalendar;
  tabName: (tab: AnalyticsTab) => string;
  /** Where the person can be reached; a channel they cannot is offered with the reason. */
  reach: { bot: boolean; email: boolean };
  /** At the person's limit: the form says so instead of failing. */
  full: boolean;
  onAdded: (schedule: ReportSchedule) => void;
}

/**
 * A new report for the person (F-1006-b): how often, the weekday of a weekly
 * one, the hour on the tenant's clock, the tab its link opens, and where it
 * goes. The month of a monthly one is the reader's calendar's.
 */
export function ReportScheduleForm({ tenantId, calendar, tabName, reach, full, onAdded }: ReportScheduleFormProps) {
  const { t, lang } = useLocale();
  const errorText = useReportError();
  const [form, setForm] = useState({ ...DEFAULT_REPORT_FORM, bot: reach.bot || !reach.email, email: !reach.bot && reach.email });
  const [saving, setSaving] = useState(false);
  const checked = reportBodyOf(form, calendar);

  const add = async () => {
    if (!("body" in checked)) return;
    setSaving(true);
    try {
      onAdded(await reportSchedulesApi.create(tenantId, checked.body));
      notify.success(t("common", R.form.added));
    } catch (e) {
      notify.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="sm">
      <CardHeader title={t("common", R.form.title)} subtitle={t("common", R.form.subtitle)} className="mb-3" />
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t("common", R.form.frequency)}>
          <SegmentedControl
            size="sm"
            ariaLabel={t("common", R.form.frequency)}
            value={form.frequency}
            onChange={(frequency) => setForm({ ...form, frequency })}
            options={REPORT_FREQUENCIES.map((f) => ({ value: f, label: t("common", R.frequencies[f]) }))}
          />
        </Field>
        {form.frequency === "weekly" && (
          <Field label={t("common", R.form.weekday)}>
            <Select value={String(form.weekday)} onChange={(v) => setForm({ ...form, weekday: Number(v) })} options={REPORT_WEEKDAYS.map((d) => ({ value: String(d), label: weekdayName(d, lang) }))} />
          </Field>
        )}
        <Field label={t("common", R.form.hour)} hint={t("common", R.form.hourHint)}>
          <Select value={String(form.hour)} onChange={(v) => setForm({ ...form, hour: Number(v) })} options={REPORT_HOURS.map((h) => ({ value: String(h), label: hourName(h, lang) }))} />
        </Field>
        <Field label={t("common", R.form.tab)}>
          <Select value={form.tab} onChange={(v) => setForm({ ...form, tab: REPORT_TABS.find((tab) => tab === v) ?? form.tab })} options={REPORT_TABS.map((tab) => ({ value: tab, label: tabName(tab) }))} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-4">
        <Checkbox checked={form.bot} disabled={!reach.bot} onChange={(bot) => setForm({ ...form, bot })} label={t("common", R.channels.bot)} hint={reach.bot ? undefined : t("common", R.form.botUnreachable)} />
        <Checkbox checked={form.email} disabled={!reach.email} onChange={(email) => setForm({ ...form, email })} label={t("common", R.channels.email)} hint={reach.email ? undefined : t("common", R.form.emailUnreachable)} />
      </div>
      {"error" in checked && <p className="mt-2 text-xs text-error">{t("common", R.form.noChannel)}</p>}
      {full && <p className="mt-2 text-xs text-text-secondary">{t("common", R.form.full)}</p>}
      <div className="mt-3">
        <Button size="sm" onClick={add} disabled={!("body" in checked) || saving || full}>
          {t("common", R.form.add)}
        </Button>
      </div>
    </Card>
  );
}
